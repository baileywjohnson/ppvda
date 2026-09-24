//go:build linux

// wg-supervisor is a tiny privileged helper that owns the subset of PPVDA's
// operations that require CAP_NET_ADMIN or root-owned filesystem paths —
// bringing the WireGuard tunnel up/down, editing /etc/resolv.conf, and
// routing a fixed set of bypass hosts around the tunnel. It speaks a
// length-prefixed JSON protocol over a Unix socket so the unprivileged PPVDA
// Node process can request these operations without running as root itself.
//
// Design constraints:
//
//   - Only PPVDA (running as the `ppvda` uid) may connect. Every accepted
//     connection is authenticated via SO_PEERCRED against a configured
//     allow-uid; anything else is closed immediately.
//
//   - No network listeners, no HTTP, no TLS, no user input beyond the RPC
//     payload. The attack surface is one Unix socket with a known peer.
//
//   - The protocol is intentionally narrow: four fixed operations, each
//     with a small typed payload. No shell, no template evaluation, no
//     arbitrary command execution — every subprocess is a fixed argv with
//     values that have been regex-validated against the documented shape.
//
//   - Frames are size-capped to 64 KiB so a bug on the PPVDA side can't
//     drive us into unbounded allocation.
//
//   - SO_PEERCRED proves the peer is the ppvda uid, not that it is the Node
//     process: Chromium (after a sandbox escape) and ffmpeg run as that uid
//     too. So nothing a caller supplies may widen what leaves the host
//     outside the tunnel. The bypass hosts are fixed by -bypass-hosts at
//     startup and resolved here; ADD_ROUTES only picks from that list.
package main

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	maxFrameBytes    = 64 * 1024
	subprocessTimeout = 30 * time.Second
	defaultSocketPath = "/run/ppvda/wg.sock"
	defaultConfigDir  = "/run/wg-supervisor"
	wgInterface       = "wg0"
	// mullvadDNS is Mullvad's in-tunnel resolver, reachable only over wg0.
	mullvadDNS = "10.64.0.1"
	// Bounds on the pinned bypass set, so a hostile resolver answer can't
	// grow the kill switch or the routing table without limit.
	maxBypassHosts      = 16
	maxBypassIPsPerHost = 8
	dnsTimeout          = 10 * time.Second
)

// configDir is the ONLY directory the supervisor will write a WireGuard
// config into. It is fixed at startup rather than taken from the RPC
// payload: accepting a caller-supplied path gave any process running as the
// ppvda uid an arbitrary root-owned MkdirAll plus a write of <dir>/wg0.conf.
// The file content was always supervisor-rendered so that was not a code-
// execution path, but it was a privilege the split exists to deny.
//
// Pinning it also removes a live failure mode: PPVDA's default
// MULLVAD_CONFIG_DIR is the *relative* "./mullvad" (src/config.ts,
// .env.example) and was forwarded verbatim, so any deployment that didn't
// override it — i.e. the manual Docker path in the README — failed BRINGUP
// with "configDir must be an absolute path".
var configDir = defaultConfigDir

// Kill-switch state. All mutation happens inside dispatch, which runs under
// opMu, so no further locking is needed.
var (
	// bootGateway is the container's original default gateway, captured
	// before any tunnel exists. Once the tunnel is up (or torn down to an
	// unreachable default) `ip route show default` no longer reveals it.
	bootGateway string
	// relayEndpoint is the current relay's "ip:port"; its UDP handshake
	// traffic is the only thing allowed out of the real interface besides
	// the bypass IPs.
	relayEndpoint string
	// bypassIPs accumulates every IP ADD_ROUTES has routed around the tunnel.
	bypassIPs = map[string]bool{}

	// bypassAllow is the set of hostnames (or IPv4 literals) ADD_ROUTES may
	// route around the tunnel. It comes from -bypass-hosts and is fixed for
	// the life of the process: a caller can only choose among these, never
	// add to them.
	bypassAllow = map[string]bool{}
	// pinnedHosts maps each routed bypass host to the addresses the
	// supervisor resolved for it. A host is resolved once; later ADD_ROUTES
	// calls (country switches) reuse the pinned addresses, which are also
	// what /etc/hosts points the app at.
	pinnedHosts = map[string][]string{}
	// tunnelUp is true between a successful BRINGUP and the next TEARDOWN.
	// It decides which resolver ADD_ROUTES may use — see bypassResolver.
	tunnelUp bool
	// bootResolvConf is /etc/resolv.conf as Docker wrote it, restored on
	// TEARDOWN so the pre-tunnel resolver is whatever this network actually
	// provides (127.0.0.11 on compose networks, host resolvers on the
	// default bridge).
	bootResolvConf []byte
)

type request struct {
	Op string `json:"op"`

	// BRINGUP: typed fields the supervisor uses to render wg0.conf itself.
	// We deliberately do NOT accept the full config text from the caller —
	// `wg-quick` honors `PostUp`/`PreUp`/`PostDown`/`PreDown` lines as
	// `/bin/sh -c …`, so a free-form config field would let any caller that
	// reaches this RPC execute arbitrary commands as root. Every field is
	// regex-validated against a tight shape before going anywhere near the
	// rendered config string.
	ConfigDir      string `json:"configDir,omitempty"`
	PrivateKey     string `json:"privateKey,omitempty"`     // base64 WG key (44 chars, "=" suffix)
	Address        string `json:"address,omitempty"`        // IPv4 CIDR ("10.x.y.z/32")
	DNS            string `json:"dns,omitempty"`            // IPv4 ("10.64.0.1")
	PeerPublicKey  string `json:"peerPublicKey,omitempty"`  // base64 WG key
	PeerEndpoint   string `json:"peerEndpoint,omitempty"`   // "ipv4:port"
	PeerAllowedIPs string `json:"peerAllowedIPs,omitempty"` // exact "0.0.0.0/0" or "::/0"
	RelayIP        string `json:"relayIP,omitempty"`        // IPv4 of the relay endpoint, for bypass route

	// Gateway is only a fallback for when the boot-time default gateway
	// could not be captured; bootGateway is used whenever it is known.
	Gateway string `json:"gateway,omitempty"`

	// ADD_ROUTES: hostnames to route around the tunnel. Each must be in the
	// -bypass-hosts allowlist; the supervisor resolves them itself and the
	// caller never supplies addresses.
	Hostnames []string `json:"hostnames,omitempty"`
}

// routedHost is one entry of ADD_ROUTES' reply: the addresses the
// supervisor routed for an allowlisted host. PPVDA needs them to refuse
// those IPs as extraction targets (src/utils/url.ts:setVpnBypassIPs).
type routedHost struct {
	Hostname string   `json:"hostname"`
	IPs      []string `json:"ips"`
}

type response struct {
	OK    bool            `json:"ok"`
	Error string          `json:"error,omitempty"`
	Data  json.RawMessage `json:"data,omitempty"`
}

var (
	// dnsNameRe is the shape of a bypass hostname: dot-separated LDH labels
	// (lower-cased before matching). ipv4Re re-validates addresses the
	// caller supplies, so the supervisor stays the single source of truth
	// for what gets into privileged subprocess argv.
	dnsNameRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$`)
	ipv4Re    = regexp.MustCompile(`^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$`)

	// WireGuard base64 keys are 32 raw bytes → 44 chars padded base64; the
	// last char is always '=' for a 32-byte input.
	wgKeyRe       = regexp.MustCompile(`^[A-Za-z0-9+/]{43}=$`)
	ipv4CIDRRe    = regexp.MustCompile(`^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/\d{1,2}$`)
	ipv4PortRe    = regexp.MustCompile(`^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{1,5}$`)
	allowedIPsSet = map[string]bool{"0.0.0.0/0": true, "::/0": true}
)

func main() {
	socketPath := flag.String("socket", defaultSocketPath, "path to the Unix socket PPVDA will connect to")
	allowUIDStr := flag.String("uid", "", "numeric uid permitted to connect (required)")
	configDirFlag := flag.String("config-dir", defaultConfigDir, "the only directory wg0.conf may be written to")
	bypassHostsFlag := flag.String("bypass-hosts", "", "comma-separated hostnames (or public IPv4 literals) ADD_ROUTES may route around the tunnel")
	flag.Parse()

	if !filepath.IsAbs(*configDirFlag) {
		log.Fatalf("-config-dir %q must be an absolute path", *configDirFlag)
	}
	configDir = filepath.Clean(*configDirFlag)
	if err := secureConfigDir(configDir); err != nil {
		log.Fatalf("config dir: %v", err)
	}

	if *allowUIDStr == "" {
		log.Fatal("-uid is required (the ppvda user's uid)")
	}
	allowUID, err := strconv.Atoi(*allowUIDStr)
	if err != nil || allowUID < 0 {
		log.Fatalf("-uid %q is not a valid uid", *allowUIDStr)
	}

	allow, err := parseBypassAllowlist(*bypassHostsFlag)
	if err != nil {
		log.Fatalf("-bypass-hosts: %v", err)
	}
	bypassAllow = allow
	names := make([]string, 0, len(allow))
	for h := range allow {
		names = append(names, h)
	}
	log.Printf("bypass allowlist: %s", strings.Join(names, ", "))

	if b, err := os.ReadFile("/etc/resolv.conf"); err == nil && len(b) > 0 {
		bootResolvConf = b
	} else {
		bootResolvConf = []byte("nameserver " + dockerDNS + "\n")
	}

	if gw, err := liveGateway(); err == nil && gw != "" {
		bootGateway = gw
	} else {
		log.Printf("warn: could not determine default gateway at startup")
	}

	if err := os.MkdirAll(filepath.Dir(*socketPath), 0o755); err != nil {
		log.Fatalf("mkdir socket dir: %v", err)
	}
	// Remove any stale socket from a previous run so we can bind fresh.
	_ = os.Remove(*socketPath)

	listener, err := net.Listen("unix", *socketPath)
	if err != nil {
		log.Fatalf("listen on %s: %v", *socketPath, err)
	}
	defer listener.Close()
	// Remove the socket file on graceful exit so the next start binds
	// fresh. (We also remove stale sockets at startup via os.Remove above,
	// but cleaning up after ourselves is good hygiene.)
	defer os.Remove(*socketPath)

	// Mode 0660 + (root:ppvda) ownership: the entrypoint chowns the socket's
	// parent directory; we also chmod here so the ppvda user can connect
	// regardless of what umask set on the listener.
	if err := os.Chmod(*socketPath, 0o660); err != nil {
		log.Printf("warn: chmod socket: %v", err)
	}
	if err := os.Chown(*socketPath, 0, allowUID); err != nil {
		log.Printf("warn: chown socket to uid=%d: %v", allowUID, err)
	}

	log.Printf("wg-supervisor listening on %s (allow-uid=%d)", *socketPath, allowUID)

	// Gracefully close the listener on SIGTERM/SIGINT so kubelet / dockerd
	// stop signals unblock Accept() and we exit cleanly.
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sig
		log.Printf("received signal, shutting down")
		listener.Close()
	}()

	// Serialize every op: the privileged side only handles one tunnel ever,
	// and parallel wg-quick invocations corrupt the routing table. The
	// critical-section is the RPC dispatch, not the accept loop.
	var opMu sync.Mutex

	for {
		conn, err := listener.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			log.Printf("accept: %v", err)
			continue
		}
		go handle(conn, allowUID, &opMu)
	}
}

// handle authenticates the peer via SO_PEERCRED, reads one request frame,
// dispatches, and writes one response frame. Connections are one-shot —
// we close after the response to keep the protocol simple and to avoid
// long-lived socket state that could mask bugs.
func handle(conn net.Conn, allowUID int, opMu *sync.Mutex) {
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(2 * subprocessTimeout))

	uc, ok := conn.(*net.UnixConn)
	if !ok {
		return
	}
	ucred, err := peerCred(uc)
	if err != nil {
		log.Printf("peercred: %v", err)
		return
	}
	if int(ucred.Uid) != allowUID {
		log.Printf("reject peer uid=%d (expected %d)", ucred.Uid, allowUID)
		return
	}

	req, err := readFrame(conn)
	if err != nil {
		writeResponse(conn, response{Error: fmt.Sprintf("read frame: %v", err)})
		return
	}

	var r request
	if err := json.Unmarshal(req, &r); err != nil {
		writeResponse(conn, response{Error: fmt.Sprintf("parse json: %v", err)})
		return
	}

	opMu.Lock()
	defer opMu.Unlock()

	resp := dispatch(r)
	writeResponse(conn, resp)
}

func dispatch(r request) response {
	switch r.Op {
	case "BRINGUP":
		return doBringup(r)
	case "TEARDOWN":
		return doTeardown(r)
	case "ADD_ROUTES":
		return doAddRoutes(r)
	case "GATEWAY":
		return doGateway()
	default:
		return response{Error: "unknown op: " + r.Op}
	}
}

// doBringup validates each typed field, renders wg0.conf from a fixed
// template, writes it (0600), and runs `wg-quick up <path>`. The config
// text is built here rather than accepted from the caller because
// `wg-quick` executes `PostUp`/`PreUp`/`PostDown`/`PreDown` directives
// via `/bin/sh -c …` — accepting free-form config from the (peer-uid-
// authenticated but otherwise unprivileged) caller would let any
// compromise of the PPVDA process escalate to root.
//
// All paths are restricted to the caller-supplied configDir which must
// be an absolute path; we don't tolerate relative paths because they
// would be resolved against the supervisor's cwd, not PPVDA's.
func doBringup(r request) response {
	// r.ConfigDir is accepted for wire compatibility but deliberately ignored
	// in favour of the pinned `configDir` — see the comment on that var.
	if r.ConfigDir != "" && filepath.Clean(r.ConfigDir) != configDir {
		log.Printf("ignoring caller configDir %q; using pinned %q", r.ConfigDir, configDir)
	}
	if !wgKeyRe.MatchString(r.PrivateKey) {
		return response{Error: "invalid privateKey"}
	}
	if !wgKeyRe.MatchString(r.PeerPublicKey) {
		return response{Error: "invalid peerPublicKey"}
	}
	if !ipv4CIDRRe.MatchString(r.Address) {
		return response{Error: "invalid address"}
	}
	if !ipv4Re.MatchString(r.DNS) {
		return response{Error: "invalid dns"}
	}
	if !ipv4PortRe.MatchString(r.PeerEndpoint) {
		return response{Error: "invalid peerEndpoint"}
	}
	if !allowedIPsSet[r.PeerAllowedIPs] {
		return response{Error: "invalid peerAllowedIPs"}
	}
	if !ipv4Re.MatchString(r.RelayIP) {
		return response{Error: "invalid relayIP"}
	}
	if !ipv4Re.MatchString(r.Gateway) {
		return response{Error: "invalid gateway"}
	}
	// The relay route's next hop is the gateway captured at boot; the
	// caller's value is only a fallback for when that capture failed.
	gateway := bootGateway
	if gateway == "" {
		gateway = r.Gateway
	}

	// Render the config from a fixed template. Every interpolation point is
	// a value that has just passed a tight regex / set-membership check, so
	// the resulting string cannot contain shell metacharacters or extra
	// directives. PostUp/PreDown still execute under `wg-quick`'s shell,
	// but their contents are entirely supervisor-controlled.
	cfg := "[Interface]\n" +
		"PrivateKey = " + r.PrivateKey + "\n" +
		"Address = " + r.Address + "\n" +
		"DNS = " + r.DNS + "\n" +
		"Table = off\n" +
		"PostUp = ip route add " + r.RelayIP + "/32 via " + gateway +
		" && ip route replace default dev " + wgInterface + "\n" +
		// On teardown the default route becomes unreachable rather than
		// reverting to the real gateway: with the tunnel down, nothing
		// should have a route out except the explicit /32 bypasses.
		"PreDown = ip route replace unreachable default" +
		" ; ip route del " + r.RelayIP + "/32 via " + gateway + "\n" +
		"\n" +
		"[Peer]\n" +
		"PublicKey = " + r.PeerPublicKey + "\n" +
		"AllowedIPs = " + r.PeerAllowedIPs + "\n" +
		"Endpoint = " + r.PeerEndpoint + "\n"

	// The egress policy goes in before the tunnel comes up and is never
	// removed: from the first BRINGUP on, nothing but the tunnel, the relay
	// handshake and the bypass IPs can leave this network namespace —
	// including across teardown, country switches and crashes of either
	// process. If it can't be installed, refuse to bring the tunnel up.
	relayEndpoint = r.PeerEndpoint
	if err := applyKillSwitch(); err != nil {
		return response{Error: "kill switch: " + err.Error()}
	}

	if err := secureConfigDir(configDir); err != nil {
		return response{Error: "config dir: " + err.Error()}
	}
	configPath := filepath.Join(configDir, wgInterface+".conf")
	if err := writeFileNoFollow(configPath, []byte(cfg)); err != nil {
		return response{Error: "write config: " + err.Error()}
	}

	if _, err := runCmd("wg-quick", "up", configPath); err != nil {
		return response{Error: "wg-quick up: " + err.Error()}
	}

	// Docker manages /etc/resolv.conf; override it so queries use the
	// Mullvad resolver through the tunnel. This is not best-effort: left
	// pointing at Docker's resolver, lookups either leak to the host's
	// resolver (if anything ever lets them through) or silently fail
	// against the kill switch. Take the tunnel back down and report it.
	if err := os.WriteFile("/etc/resolv.conf", []byte("nameserver "+mullvadDNS+"\n"), 0o644); err != nil {
		_, _ = runCmd("wg-quick", "down", configPath)
		return response{Error: "write /etc/resolv.conf: " + err.Error() + " (tunnel taken back down)"}
	}
	tunnelUp = true

	return response{OK: true}
}

// doTeardown runs `wg-quick down <path>`, restores Docker's DNS resolver
// configuration, and securely unlinks the config file (which contains the
// WireGuard private key). Best-effort throughout — the tunnel may already
// be down from a prior country-switch.
//
// Any ppvda-uid process can call this, not just Node. That is tolerated
// rather than removed (a country switch is TEARDOWN + BRINGUP): once the
// kill switch is installed it is never lifted, so a hostile TEARDOWN only
// takes egress down — a denial of service the same uid can already cause by
// killing Node — and cannot expose the real IP.
func doTeardown(r request) response {
	// Same as doBringup: the caller's configDir is ignored in favour of the
	// pinned one, so teardown always targets the file we actually wrote.
	configPath := filepath.Join(configDir, wgInterface+".conf")

	// Ignore errors — tunnel may not exist
	_, _ = runCmd("wg-quick", "down", configPath)
	tunnelUp = false

	// Restore the resolver config Docker provided. Without this,
	// /etc/resolv.conf still points at 10.64.0.1 (unreachable once the
	// tunnel is down) and every DNS query after teardown times out. With
	// the kill switch installed these queries are rejected anyway; before
	// the first BRINGUP (PPVDA's stale-tunnel cleanup) they must keep
	// working.
	_ = os.WriteFile("/etc/resolv.conf", bootResolvConf, 0o644)

	secureUnlink(configPath)

	return response{OK: true}
}

// doAddRoutes routes the requested bypass hosts around the tunnel and
// returns the addresses it routed. Hosts must come from the -bypass-hosts
// allowlist and are resolved here: the caller names hosts, never IPs.
// Accepting caller IPs let any ppvda-uid process (Chromium after a sandbox
// escape, ffmpeg) exempt an address of its choice from the kill switch and
// learn the real IP by connecting to it.
//
// Each host is resolved once and pinned (routes, kill-switch rule and an
// /etc/hosts line, so the app connects to exactly the routed addresses).
// A refused or unresolvable host is reported in "errors" and skipped; the
// others are still routed.
func doAddRoutes(r request) response {
	gateway := bootGateway
	if gateway == "" {
		if !ipv4Re.MatchString(r.Gateway) {
			return response{Error: "no default gateway known"}
		}
		gateway = r.Gateway
	}
	if len(r.Hostnames) == 0 {
		return response{Error: "no hostnames"}
	}
	if len(r.Hostnames) > maxBypassHosts {
		return response{Error: "too many hostnames"}
	}

	type reply struct {
		Hosts  []routedHost `json:"hosts"`
		Errors []string     `json:"errors,omitempty"`
	}
	out := reply{Hosts: []routedHost{}}
	var done []string
	for _, raw := range r.Hostnames {
		host := strings.ToLower(strings.TrimSpace(raw))
		if contains(done, host) {
			continue
		}
		done = append(done, host)
		if !bypassAllow[host] {
			if len(host) > 64 {
				host = host[:64] + "..."
			}
			out.Errors = append(out.Errors, fmt.Sprintf("%q: not in the -bypass-hosts allowlist", host))
			continue
		}

		ips, pinned := pinnedHosts[host]
		if !pinned {
			var err error
			if ips, err = resolveBypassHost(host); err != nil {
				out.Errors = append(out.Errors, host+": "+err.Error())
				continue
			}
		}
		var routeErr error
		for _, ip := range ips {
			// replace, not add: idempotent across country switches, so a
			// failure here is a real one.
			if _, err := runCmd("ip", "route", "replace", ip+"/32", "via", gateway); err != nil {
				routeErr = err
				break
			}
		}
		if routeErr != nil {
			out.Errors = append(out.Errors, host+": "+routeErr.Error())
			continue
		}
		pinnedHosts[host] = ips
		for _, ip := range ips {
			bypassIPs[ip] = true
		}
		out.Hosts = append(out.Hosts, routedHost{Hostname: host, IPs: ips})
	}

	if err := writeHostsEntries(out.Hosts); err != nil {
		out.Errors = append(out.Errors, "/etc/hosts: "+err.Error())
	}

	// Once the kill switch is live, newly routed bypass IPs must also be
	// allowed through it. Before the first BRINGUP it isn't installed yet;
	// BRINGUP picks the accumulated set up then.
	if relayEndpoint != "" {
		if err := applyKillSwitch(); err != nil {
			return response{Error: "kill switch: " + err.Error()}
		}
	}

	data, _ := json.Marshal(out)
	return response{OK: true, Data: data}
}

// writeHostsEntries appends unique `<ip> <hostname>` lines to /etc/hosts so
// the app resolves each bypass host to the addresses that were routed (after
// BRINGUP the resolver is Mullvad's, whose answer may differ). IPv4 literals
// in the allowlist need no entry.
func writeHostsEntries(hosts []routedHost) error {
	existing, _ := os.ReadFile("/etc/hosts")
	existingStr := string(existing)

	var newEntries []string
	for _, h := range hosts {
		if _, err := netip.ParseAddr(h.Hostname); err == nil || !dnsNameRe.MatchString(h.Hostname) {
			continue
		}
		for _, ip := range h.IPs {
			entry := ip + " " + h.Hostname
			lineRe := regexp.MustCompile(`(?m)^` + regexp.QuoteMeta(entry) + `\s*$`)
			if !lineRe.MatchString(existingStr) && !contains(newEntries, entry) {
				newEntries = append(newEntries, entry)
			}
		}
	}
	if len(newEntries) == 0 {
		return nil
	}
	sep := ""
	if existingStr != "" && !strings.HasSuffix(existingStr, "\n") {
		sep = "\n"
	}
	out := existingStr + sep + strings.Join(newEntries, "\n") + "\n"
	return os.WriteFile("/etc/hosts", []byte(out), 0o644)
}

// parseBypassAllowlist turns the -bypass-hosts value into the fixed
// allowlist. Entries are normalised the way PPVDA's config does
// (src/config.ts:parseHostList — trimmed, lower-cased); anything that is
// neither a DNS name nor a public IPv4 literal is logged and dropped, so a
// typo in VPN_BYPASS_HOSTS costs that one bypass rather than the VPN.
func parseBypassAllowlist(v string) (map[string]bool, error) {
	allow := map[string]bool{}
	for _, raw := range strings.Split(v, ",") {
		h := strings.ToLower(strings.TrimSpace(raw))
		if h == "" {
			continue
		}
		if addr, err := netip.ParseAddr(h); err == nil {
			if !isPublicUnicastV4(addr) {
				log.Printf("warn: -bypass-hosts: ignoring %q (not a public unicast IPv4 address)", h)
				continue
			}
		} else if len(h) > 253 || !dnsNameRe.MatchString(h) {
			log.Printf("warn: -bypass-hosts: ignoring %q (not a valid hostname)", h)
			continue
		}
		allow[h] = true
	}
	if len(allow) > maxBypassHosts {
		return nil, fmt.Errorf("more than %d hosts", maxBypassHosts)
	}
	return allow, nil
}

// resolveBypassHost returns the IPv4 addresses to route for an allowlisted
// host. Every address must be public unicast: a bypass exists to reach a
// public service (Mullvad's API, a remote Darkreel), and an answer
// containing private, loopback, CGNAT or reserved space is refused outright
// rather than filtered.
func resolveBypassHost(host string) ([]string, error) {
	if addr, err := netip.ParseAddr(host); err == nil {
		if !isPublicUnicastV4(addr) {
			return nil, errors.New("not a public unicast IPv4 address")
		}
		return []string{addr.String()}, nil
	}
	res, err := bypassResolver()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), dnsTimeout)
	defer cancel()
	addrs, err := res.LookupNetIP(ctx, "ip4", host)
	if err != nil {
		return nil, err
	}
	var ips []string
	for _, a := range addrs {
		a = a.Unmap()
		if !isPublicUnicastV4(a) {
			return nil, fmt.Errorf("resolved to non-public address %s", a)
		}
		if s := a.String(); !contains(ips, s) && len(ips) < maxBypassIPsPerHost {
			ips = append(ips, s)
		}
	}
	if len(ips) == 0 {
		return nil, errors.New("no IPv4 addresses")
	}
	return ips, nil
}

// bypassResolver picks the DNS path for resolving a bypass host:
//
//   - before the first BRINGUP there is no kill switch, and the resolver is
//     whatever Docker configured (its embedded 127.0.0.11, or the host's
//     resolvers on the default bridge);
//   - while the tunnel is up, Mullvad's resolver over wg0. It is dialled
//     explicitly because Go re-reads resolv.conf at most every 5 s and could
//     still be using Docker's resolver, which the kill switch rejects;
//   - with the kill switch installed and the tunnel down, nothing can
//     resolve, so only already-pinned hosts can be (re)routed.
func bypassResolver() (*net.Resolver, error) {
	switch {
	case tunnelUp:
		server := net.JoinHostPort(mullvadDNS, "53")
		return &net.Resolver{
			PreferGo: true,
			Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, network, server)
			},
		}, nil
	case relayEndpoint == "":
		return net.DefaultResolver, nil
	default:
		return nil, errors.New("tunnel is down and the kill switch blocks DNS; resolve bypass hosts before the first BRINGUP or while the tunnel is up")
	}
}

// Special-purpose IPv4 ranges netip's predicates don't cover.
var nonPublicV4 = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"), // CGNAT
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"), // incl. 255.255.255.255
}

// isPublicUnicastV4 reports whether a is a globally routable unicast IPv4
// address: not private, loopback, link-local, multicast, CGNAT, reserved or
// documentation space.
func isPublicUnicastV4(a netip.Addr) bool {
	if !a.Is4() || !a.IsGlobalUnicast() || a.IsPrivate() {
		return false
	}
	for _, p := range nonPublicV4 {
		if p.Contains(a) {
			return false
		}
	}
	return true
}

// doGateway runs `ip route show default` and returns the first "default
// via <ip>" IP. The result is only useful *before* the tunnel is up —
// afterward, the default route points at wg0. PPVDA captures this up-
// front so teardown/bring-up cycles know which IP the original gateway
// was. Kept in the supervisor because `ip` is in the same toolbox as the
// other privileged ops; technically `ip route show default` doesn't need
// privileges, so this could be done client-side if we ever trim surface.
func doGateway() response {
	gw := bootGateway
	if gw == "" {
		live, err := liveGateway()
		if err != nil {
			return response{Error: err.Error()}
		}
		gw = live
	}
	data, _ := json.Marshal(map[string]string{"gateway": gw})
	return response{OK: true, Data: data}
}

// liveGateway returns the "via" address of the current default route.
func liveGateway() (string, error) {
	stdout, err := runCmd("ip", "route", "show", "default")
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(stdout, "\n") {
		fields := strings.Fields(line)
		for i, f := range fields {
			if f == "via" && i+1 < len(fields) && ipv4Re.MatchString(fields[i+1]) {
				return fields[i+1], nil
			}
		}
	}
	return "", nil
}

const (
	ksChain  = "PPVDA_KILLSWITCH"
	ksChain6 = "PPVDA_KILLSWITCH6"
	// Docker's embedded resolver. It forwards queries through dockerd on
	// the host, i.e. to the host's resolver outside the tunnel.
	dockerDNS = "127.0.0.11"
)

// applyKillSwitch (re)builds the egress policy for this network namespace.
// Each chain is replaced in a single iptables-restore transaction, so there
// is no moment where it is flushed but not yet repopulated. Allowed out:
//
//   - loopback (except Docker's embedded DNS, which would leak queries)
//   - anything over the tunnel interface
//   - replies to connections that came IN (the published web port)
//   - UDP to the current relay endpoint (the WireGuard handshake itself)
//   - the bypass IPs from ADD_ROUTES (Mullvad API, Darkreel)
//
// Everything else is rejected, whatever the routing table says.
func applyKillSwitch() error {
	var b strings.Builder
	b.WriteString("*filter\n:" + ksChain + " - [0:0]\n-F " + ksChain + "\n")
	b.WriteString("-A " + ksChain + " -o lo -d " + dockerDNS + " -j REJECT\n")
	b.WriteString("-A " + ksChain + " -o lo -j RETURN\n")
	b.WriteString("-A " + ksChain + " -o " + wgInterface + " -j RETURN\n")
	b.WriteString("-A " + ksChain + " -m conntrack --ctdir REPLY -j RETURN\n")
	if relayEndpoint != "" {
		host, port, err := net.SplitHostPort(relayEndpoint)
		if err != nil || !ipv4Re.MatchString(host) {
			return fmt.Errorf("invalid relay endpoint %q", relayEndpoint)
		}
		if _, err := strconv.ParseUint(port, 10, 16); err != nil {
			return fmt.Errorf("invalid relay port %q", port)
		}
		b.WriteString("-A " + ksChain + " -d " + host + "/32 -p udp --dport " + port + " -j RETURN\n")
	}
	for ip := range bypassIPs {
		b.WriteString("-A " + ksChain + " -d " + ip + "/32 -j RETURN\n")
	}
	b.WriteString("-A " + ksChain + " -j REJECT\n")
	b.WriteString("COMMIT\n")
	if _, err := runCmdStdin(b.String(), "iptables-restore", "-w", "--noflush"); err != nil {
		return err
	}
	if err := ensureJump("iptables", ksChain); err != nil {
		return err
	}

	// The tunnel is IPv4-only, so nothing but loopback and replies may
	// leave over IPv6. If ip6tables is unavailable that's only acceptable
	// when IPv6 is disabled outright.
	rules6 := "*filter\n:" + ksChain6 + " - [0:0]\n-F " + ksChain6 + "\n" +
		"-A " + ksChain6 + " -o lo -j RETURN\n" +
		"-A " + ksChain6 + " -m conntrack --ctdir REPLY -j RETURN\n" +
		"-A " + ksChain6 + " -j REJECT\n" +
		"COMMIT\n"
	_, err6 := runCmdStdin(rules6, "ip6tables-restore", "-w", "--noflush")
	if err6 == nil {
		err6 = ensureJump("ip6tables", ksChain6)
	}
	if err6 != nil {
		if disabled, _ := os.ReadFile("/proc/sys/net/ipv6/conf/all/disable_ipv6"); strings.TrimSpace(string(disabled)) != "1" {
			return fmt.Errorf("ip6tables policy failed and IPv6 is enabled: %v", err6)
		}
	}
	return nil
}

// ensureJump makes chain the first rule of OUTPUT, adding it only once.
func ensureJump(bin, chain string) error {
	if _, err := runCmd(bin, "-w", "-C", "OUTPUT", "-j", chain); err == nil {
		return nil
	}
	_, err := runCmd(bin, "-w", "-I", "OUTPUT", "1", "-j", chain)
	return err
}

// runCmd is the single place subprocesses are started from. Fixed argv,
// no shell, small timeout, bounded output. Never PATH-searches user-
// controllable values — `wg-quick`, `ip`, etc. are found via the
// container's PATH but the first argv element is always a hard-coded
// literal.
func runCmd(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	cmd.Env = []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}

	timer := time.AfterFunc(subprocessTimeout, func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
	})
	defer timer.Stop()

	out, err := cmd.CombinedOutput()
	if len(out) > 16*1024 {
		out = out[:16*1024]
	}
	if err != nil {
		return string(out), fmt.Errorf("%s %s: %v: %s", name, strings.Join(args, " "), err, string(out))
	}
	return string(out), nil
}

// runCmdStdin is runCmd with the given input on stdin (for *-restore).
func runCmdStdin(input, name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	cmd.Env = []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}
	cmd.Stdin = strings.NewReader(input)

	timer := time.AfterFunc(subprocessTimeout, func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
	})
	defer timer.Stop()

	out, err := cmd.CombinedOutput()
	if len(out) > 16*1024 {
		out = out[:16*1024]
	}
	if err != nil {
		return string(out), fmt.Errorf("%s %s: %v: %s", name, strings.Join(args, " "), err, string(out))
	}
	return string(out), nil
}

// secureConfigDir creates dir if needed and verifies it is a real directory
// (not a symlink) owned by root with mode 0700. The supervisor writes and
// shreds files in it as root, so if any other user could create entries in
// it — as they could when it was the ppvda-owned /app/mullvad — a planted
// symlink would turn those writes into arbitrary root file overwrites.
func secureConfigDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("%s is not a directory", dir)
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || st.Uid != 0 {
		return fmt.Errorf("%s must be owned by root", dir)
	}
	if info.Mode().Perm() != 0o700 {
		if err := os.Chmod(dir, 0o700); err != nil {
			return err
		}
	}
	return nil
}

// writeFileNoFollow replaces path with a new 0600 file without following a
// symlink or reusing an existing inode: any existing entry is removed, then
// the file is created with O_EXCL|O_NOFOLLOW.
func writeFileNoFollow(path string, data []byte) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// secureUnlink overwrites a file with random bytes and fsyncs before
// unlinking it. Best-effort "don't leave the WG private key sitting in
// recoverable slack" — same caveats as PPVDA's own secureUnlink
// (CoW filesystems and SSDs can defeat the overwrite). Symlinks and
// non-regular files are only unlinked, never opened.
func secureUnlink(path string) {
	info, err := os.Lstat(path)
	if err != nil {
		return
	}
	if !info.Mode().IsRegular() {
		_ = os.Remove(path)
		return
	}
	f, err := os.OpenFile(path, os.O_WRONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil || !os.SameFile(info, stat) {
		return
	}
	buf := make([]byte, 4096)
	if _, err := rand.Read(buf); err != nil {
		// Fall back to the zero buffer — still destroys the key material,
		// which is the property we actually need here.
		clear(buf)
	}
	remaining := stat.Size()
	for remaining > 0 {
		n := int64(len(buf))
		if remaining < n {
			n = remaining
		}
		if _, err := f.Write(buf[:n]); err != nil {
			break
		}
		remaining -= n
	}
	_ = f.Sync()
	_ = os.Remove(path)
}

// peerCred extracts the peer's (pid, uid, gid) from a Unix socket via
// SO_PEERCRED. Linux-specific; the supervisor only runs inside the PPVDA
// container so non-Linux builds are not a concern.
func peerCred(c *net.UnixConn) (*syscall.Ucred, error) {
	raw, err := c.SyscallConn()
	if err != nil {
		return nil, err
	}
	var ucred *syscall.Ucred
	var gerr error
	err = raw.Control(func(fd uintptr) {
		ucred, gerr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	})
	if err != nil {
		return nil, err
	}
	return ucred, gerr
}

func readFrame(r io.Reader) ([]byte, error) {
	var lenBuf [4]byte
	if _, err := io.ReadFull(r, lenBuf[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(lenBuf[:])
	if n == 0 || n > maxFrameBytes {
		return nil, fmt.Errorf("frame length %d out of range", n)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

func writeResponse(w io.Writer, resp response) {
	payload, err := json.Marshal(resp)
	if err != nil {
		// Best-effort fallback — if JSON encoding itself fails the client
		// gets a protocol error on the length prefix and will retry.
		payload = []byte(`{"ok":false,"error":"internal encode failure"}`)
	}
	if len(payload) > maxFrameBytes {
		payload = []byte(`{"ok":false,"error":"response too large"}`)
	}
	var lenBuf [4]byte
	binary.BigEndian.PutUint32(lenBuf[:], uint32(len(payload)))
	_, _ = w.Write(lenBuf[:])
	_, _ = w.Write(payload)
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}
