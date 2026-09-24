//go:build linux

// wg-supervisor is a tiny privileged helper that owns the subset of PPVDA's
// operations that require CAP_NET_ADMIN or root-owned filesystem paths —
// bringing the WireGuard tunnel up/down, editing /etc/resolv.conf, and
// adding per-host bypass routes. It speaks a length-prefixed JSON protocol
// over a Unix socket so the unprivileged PPVDA Node process can request
// these operations without running as root itself.
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
package main

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
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

	// ADD_ROUTES (and shared with BRINGUP for the PostUp/PreDown gateway):
	// adds `ip route add <ip>/32 via <gateway>` for each (host, ip) pair and
	// appends unique `<ip> <host>` lines to /etc/hosts.
	Gateway string       `json:"gateway,omitempty"`
	Hosts   []hostBypass `json:"hosts,omitempty"`
}

type hostBypass struct {
	Hostname string   `json:"hostname"`
	IPs      []string `json:"ips"`
}

type response struct {
	OK    bool            `json:"ok"`
	Error string          `json:"error,omitempty"`
	Data  json.RawMessage `json:"data,omitempty"`
}

var (
	// hostnameRe and ipv4Re match the same shapes PPVDA's wireguard.ts already
	// validated against before sending — re-validating here keeps the
	// supervisor the single source of truth for what gets into privileged
	// subprocess argv, so a bug in PPVDA can't smuggle a malformed value.
	hostnameRe = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)
	ipv4Re     = regexp.MustCompile(`^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$`)

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
		"PostUp = ip route add " + r.RelayIP + "/32 via " + r.Gateway +
		" && ip route replace default dev " + wgInterface + "\n" +
		// On teardown the default route becomes unreachable rather than
		// reverting to the real gateway: with the tunnel down, nothing
		// should have a route out except the explicit /32 bypasses.
		"PreDown = ip route replace unreachable default" +
		" ; ip route del " + r.RelayIP + "/32 via " + r.Gateway + "\n" +
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
	// Mullvad resolver through the tunnel. Best-effort: if it fails, DNS
	// falls back to Docker's embedded resolver (still functional, less
	// private).
	_ = os.WriteFile("/etc/resolv.conf", []byte("nameserver 10.64.0.1\n"), 0o644)

	return response{OK: true}
}

// doTeardown runs `wg-quick down <path>`, restores Docker's embedded DNS
// resolver, and securely unlinks the config file (which contains the
// WireGuard private key). Best-effort throughout — the tunnel may already
// be down from a prior country-switch.
func doTeardown(r request) response {
	// Same as doBringup: the caller's configDir is ignored in favour of the
	// pinned one, so teardown always targets the file we actually wrote.
	configPath := filepath.Join(configDir, wgInterface+".conf")

	// Ignore errors — tunnel may not exist
	_, _ = runCmd("wg-quick", "down", configPath)

	// Restore Docker's embedded resolver. Without this, /etc/resolv.conf
	// still points at 10.64.0.1 (unreachable once the tunnel is down) and
	// every DNS query after teardown times out.
	_ = os.WriteFile("/etc/resolv.conf", []byte("nameserver 127.0.0.11\n"), 0o644)

	secureUnlink(configPath)

	return response{OK: true}
}

// doAddRoutes writes `ip route add <ip>/32 via <gateway>` for each
// validated (host, ip) pair and appends unique `<ip> <hostname>` lines to
// /etc/hosts. Validation regexes are applied here too so a malformed
// value can never reach argv.
func doAddRoutes(r request) response {
	if !ipv4Re.MatchString(r.Gateway) {
		return response{Error: "invalid gateway"}
	}

	// Build unique entries first so we can dedupe against the existing
	// /etc/hosts in one read.
	existing, _ := os.ReadFile("/etc/hosts")
	existingStr := string(existing)

	var newEntries []string
	for _, h := range r.Hosts {
		if !hostnameRe.MatchString(h.Hostname) {
			continue
		}
		for _, ip := range h.IPs {
			if !ipv4Re.MatchString(ip) {
				continue
			}
			// Best-effort route add — may already exist.
			_, _ = runCmd("ip", "route", "add", ip+"/32", "via", r.Gateway)
			bypassIPs[ip] = true

			entry := ip + " " + h.Hostname
			lineRe := regexp.MustCompile(`(?m)^` + regexp.QuoteMeta(entry) + `\s*$`)
			if !lineRe.MatchString(existingStr) && !contains(newEntries, entry) {
				newEntries = append(newEntries, entry)
			}
		}
	}

	if len(newEntries) > 0 {
		sep := ""
		if existingStr != "" && !strings.HasSuffix(existingStr, "\n") {
			sep = "\n"
		}
		out := existingStr + sep + strings.Join(newEntries, "\n") + "\n"
		_ = os.WriteFile("/etc/hosts", []byte(out), 0o644)
	}

	// Once the kill switch is live, newly routed bypass IPs must also be
	// allowed through it. Before the first BRINGUP it isn't installed yet;
	// BRINGUP picks the accumulated set up then.
	if relayEndpoint != "" {
		if err := applyKillSwitch(); err != nil {
			return response{Error: "kill switch: " + err.Error()}
		}
	}

	return response{OK: true}
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
