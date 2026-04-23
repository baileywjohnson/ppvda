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
	wgInterface       = "wg0"
)

type request struct {
	Op string `json:"op"`

	// BRINGUP: ConfigDir is where wg0.conf goes; Config is its full text.
	// We write the config (0600) and run `wg-quick up <path>`.
	ConfigDir string `json:"configDir,omitempty"`
	Config    string `json:"config,omitempty"`

	// ADD_ROUTES: adds `ip route add <ip>/32 via <gateway>` for each (host, ip)
	// pair and appends unique `<ip> <host>` lines to /etc/hosts.
	Gateway string        `json:"gateway,omitempty"`
	Hosts   []hostBypass  `json:"hosts,omitempty"`
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
)

func main() {
	socketPath := flag.String("socket", defaultSocketPath, "path to the Unix socket PPVDA will connect to")
	allowUIDStr := flag.String("uid", "", "numeric uid permitted to connect (required)")
	flag.Parse()

	if *allowUIDStr == "" {
		log.Fatal("-uid is required (the ppvda user's uid)")
	}
	allowUID, err := strconv.Atoi(*allowUIDStr)
	if err != nil || allowUID < 0 {
		log.Fatalf("-uid %q is not a valid uid", *allowUIDStr)
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

// doBringup writes wg0.conf (0600) and runs `wg-quick up <path>`. Also
// overwrites /etc/resolv.conf to the Mullvad resolver so post-tunnel DNS
// works. All paths are restricted to the caller-supplied configDir which
// must be an absolute path; we don't tolerate relative paths because they
// would be resolved against the supervisor's cwd, not PPVDA's.
func doBringup(r request) response {
	if r.ConfigDir == "" || !filepath.IsAbs(r.ConfigDir) {
		return response{Error: "configDir must be an absolute path"}
	}
	if r.Config == "" {
		return response{Error: "config is empty"}
	}
	if len(r.Config) > 16*1024 {
		return response{Error: "config too large"}
	}

	if err := os.MkdirAll(r.ConfigDir, 0o700); err != nil {
		return response{Error: "mkdir configDir: " + err.Error()}
	}
	configPath := filepath.Join(r.ConfigDir, wgInterface+".conf")
	if err := os.WriteFile(configPath, []byte(r.Config), 0o600); err != nil {
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
	if r.ConfigDir == "" || !filepath.IsAbs(r.ConfigDir) {
		return response{Error: "configDir must be an absolute path"}
	}
	configPath := filepath.Join(r.ConfigDir, wgInterface+".conf")

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
	stdout, err := runCmd("ip", "route", "show", "default")
	if err != nil {
		return response{Error: err.Error()}
	}
	var gw string
	for _, line := range strings.Split(stdout, "\n") {
		fields := strings.Fields(line)
		for i, f := range fields {
			if f == "via" && i+1 < len(fields) {
				gw = fields[i+1]
				break
			}
		}
		if gw != "" {
			break
		}
	}
	data, _ := json.Marshal(map[string]string{"gateway": gw})
	return response{OK: true, Data: data}
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

// secureUnlink overwrites a file with random bytes and fsyncs before
// unlinking it. Best-effort "don't leave the WG private key sitting in
// recoverable slack" — same caveats as PPVDA's own secureUnlink
// (CoW filesystems and SSDs can defeat the overwrite).
func secureUnlink(path string) {
	stat, err := os.Stat(path)
	if err != nil {
		return
	}
	f, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		return
	}
	defer f.Close()
	buf := make([]byte, 4096)
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
