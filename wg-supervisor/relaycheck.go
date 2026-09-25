// Relay verification for BRINGUP.
//
// SO_PEERCRED proves only that the caller runs as the ppvda uid, and so do
// Chromium and ffmpeg. If BRINGUP accepted any endpoint, code running as that
// uid could point the tunnel at a host it controls: the kill switch would
// then allow UDP to it, the WireGuard handshake would hand it the server's
// real IP, and as the "relay" it would receive every tunneled packet. So the
// supervisor only brings the tunnel up to a relay that Mullvad itself lists,
// and it fetches that list itself — over HTTPS, from api.mullvad.net, dialing
// only the addresses it pinned for that host (the ones ADD_ROUTES routes
// around the tunnel), with the certificate verified against the system roots
// for "api.mullvad.net". Nothing about the fetch (URL, host, addresses, CA)
// comes from the caller.
//
// This file has no Linux-only code so the checks can be unit-tested on any
// OS; main.go wires it into doBringup.
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

const (
	// relayListURL is the endpoint PPVDA's Node side picks relays from
	// (src/mullvad/api.ts:getRelayList). It is a constant, not a flag: the
	// production path must not be redirectable.
	relayListURL = "https://api.mullvad.net/app/v1/relays"
	relayAPIHost = "api.mullvad.net"

	// relayListTTL is how long a fetched list is trusted without refetching.
	relayListTTL = 10 * time.Minute
	// relayListMissRefresh: a rejection against a list at least this old
	// triggers one refetch, so a relay Node just saw in a fresher copy of the
	// list isn't refused because ours is a few minutes stale. It also caps how
	// often a caller can make us refetch by sending bad endpoints.
	relayListMissRefresh = time.Minute
	// maxRelayListBytes bounds the (decompressed) response. The list was
	// ~570 KB in September 2026.
	maxRelayListBytes = 8 << 20
	relayListTimeout  = 15 * time.Second
	relayDialTimeout  = 5 * time.Second

	// defaultWGPort is the only port allowed if the list carries no usable
	// wireguard.port_ranges. Mullvad's standard WireGuard port is 51820 (the
	// one PPVDA always uses); the list has advertised port_ranges since at
	// least 2023, so this is a conservative fallback, not the normal path.
	defaultWGPort = 51820
)

// mullvadDNS is Mullvad's in-tunnel resolver (and the relay list's
// ipv4_gateway), reachable only over wg0.
const mullvadDNS = "10.64.0.1"

// mullvadTunnelNet is Mullvad's in-tunnel IPv4 space: device addresses are
// assigned from it and its resolver/gateway is 10.64.0.1 (mullvadDNS).
var mullvadTunnelNet = netip.MustParsePrefix("10.64.0.0/10")

type wgRelay struct {
	Hostname   string `json:"hostname"`
	Active     bool   `json:"active"`
	IPv4AddrIn string `json:"ipv4_addr_in"`
	PublicKey  string `json:"public_key"`
}

type portRange struct{ lo, hi uint16 }

// relayList is the part of Mullvad's relay list the supervisor needs: the
// WireGuard relays and the ports they accept.
type relayList struct {
	relays  []wgRelay
	ports   []portRange
	fetched time.Time
}

// parseRelayList decodes the relay-list JSON. Only the "wireguard" section
// is used, so an OpenVPN or bridge relay can never match.
func parseRelayList(body []byte) (*relayList, error) {
	var raw struct {
		WireGuard *struct {
			PortRanges [][]int   `json:"port_ranges"`
			Relays     []wgRelay `json:"relays"`
		} `json:"wireguard"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("parse relay list: %v", err)
	}
	if raw.WireGuard == nil || len(raw.WireGuard.Relays) == 0 {
		return nil, errors.New("relay list has no wireguard relays")
	}
	l := &relayList{relays: raw.WireGuard.Relays}
	for _, pr := range raw.WireGuard.PortRanges {
		if len(pr) != 2 || pr[0] < 1 || pr[0] > pr[1] || pr[1] > 65535 {
			continue
		}
		l.ports = append(l.ports, portRange{uint16(pr[0]), uint16(pr[1])})
	}
	if len(l.ports) == 0 {
		l.ports = []portRange{{defaultWGPort, defaultWGPort}}
	}
	return l, nil
}

// check accepts ep only if some relay in the list is an active WireGuard
// relay whose public key is pubKey and whose ipv4_addr_in is ep's address,
// and ep's port is within the advertised WireGuard port ranges. Mismatches
// are rejected, never corrected.
func (l *relayList) check(pubKey string, ep netip.AddrPort) error {
	portOK := false
	for _, pr := range l.ports {
		if ep.Port() >= pr.lo && ep.Port() <= pr.hi {
			portOK = true
			break
		}
	}
	if !portOK {
		return fmt.Errorf("port %d is not an advertised Mullvad WireGuard port", ep.Port())
	}

	var keyHost string
	for _, r := range l.relays {
		if r.PublicKey != pubKey {
			continue
		}
		keyHost = r.Hostname
		a, err := netip.ParseAddr(r.IPv4AddrIn)
		if err != nil || !a.Is4() || a != ep.Addr() {
			continue
		}
		if !r.Active {
			return fmt.Errorf("relay %s is not active", r.Hostname)
		}
		return nil
	}
	if keyHost != "" {
		return fmt.Errorf("%s is not the address Mullvad lists for relay %s", ep.Addr(), keyHost)
	}
	return errors.New("peerPublicKey is not a listed Mullvad WireGuard relay")
}

// relayVerifier fetches and caches the relay list. It is only used from
// dispatch, which holds opMu, so it needs no locking of its own.
type relayVerifier struct {
	url string
	// rootCAs is nil in production (system roots); tests set a private CA.
	rootCAs *x509.CertPool
	now     func() time.Time
	cache   *relayList
}

func newRelayVerifier() *relayVerifier {
	return &relayVerifier{url: relayListURL, now: time.Now}
}

// verify checks (pubKey, ep) against the relay list. dialAddrs returns the
// "ip:port" addresses the list may be fetched from; it is only called when a
// fetch is needed. Any failure to obtain the list rejects the endpoint.
func (v *relayVerifier) verify(pubKey string, ep netip.AddrPort, dialAddrs func() ([]string, error)) error {
	list, err := v.get(false, dialAddrs)
	if err != nil {
		return err
	}
	err = list.check(pubKey, ep)
	if err != nil && v.now().Sub(list.fetched) >= relayListMissRefresh {
		if list, err = v.get(true, dialAddrs); err != nil {
			return err
		}
		err = list.check(pubKey, ep)
	}
	return err
}

func (v *relayVerifier) get(force bool, dialAddrs func() ([]string, error)) (*relayList, error) {
	if !force && v.cache != nil {
		if age := v.now().Sub(v.cache.fetched); age >= 0 && age < relayListTTL {
			return v.cache, nil
		}
	}
	list, err := v.fetch(dialAddrs)
	if err != nil {
		// Fail closed, and don't keep serving a list we could not refresh.
		v.cache = nil
		return nil, fmt.Errorf("fetch Mullvad relay list: %w", err)
	}
	list.fetched = v.now()
	v.cache = list
	log.Printf("relay list: fetched %d WireGuard relays from %s", len(list.relays), v.url)
	return list, nil
}

func (v *relayVerifier) fetch(dialAddrs func() ([]string, error)) (*relayList, error) {
	u, err := url.Parse(v.url)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" {
		return nil, fmt.Errorf("invalid relay list URL %q", v.url)
	}
	port := u.Port()
	if port == "" {
		port = "443"
	}
	want := net.JoinHostPort(u.Hostname(), port)

	tr := &http.Transport{
		// Never via a proxy from the environment: the list must come
		// straight from the pinned addresses.
		Proxy: nil,
		// The URL's host is never resolved; the connection goes to the
		// addresses the supervisor pinned for it. TLS still verifies the
		// certificate against the URL's host name.
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			if addr != want {
				return nil, fmt.Errorf("refusing to dial %s", addr)
			}
			addrs, err := dialAddrs()
			if err != nil {
				return nil, err
			}
			if len(addrs) == 0 {
				return nil, errors.New("no addresses to fetch the relay list from")
			}
			d := net.Dialer{Timeout: relayDialTimeout}
			var errs []string
			for _, a := range addrs {
				c, err := d.DialContext(ctx, "tcp4", a)
				if err == nil {
					return c, nil
				}
				errs = append(errs, err.Error())
			}
			return nil, errors.New(strings.Join(errs, "; "))
		},
		TLSClientConfig: &tls.Config{
			ServerName: u.Hostname(),
			RootCAs:    v.rootCAs,
			MinVersion: tls.VersionTLS12,
		},
		TLSHandshakeTimeout:    10 * time.Second,
		ResponseHeaderTimeout:  10 * time.Second,
		MaxResponseHeaderBytes: 64 << 10,
		DisableKeepAlives:      true,
	}
	defer tr.CloseIdleConnections()
	client := &http.Client{
		Transport: tr,
		Timeout:   relayListTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("redirect refused")
		},
	}

	req, err := http.NewRequest(http.MethodGet, v.url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "ppvda-wg-supervisor")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	if resp.ContentLength > maxRelayListBytes {
		return nil, fmt.Errorf("response too large (%d bytes)", resp.ContentLength)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxRelayListBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxRelayListBytes {
		return nil, fmt.Errorf("response larger than %d bytes", maxRelayListBytes)
	}
	return parseRelayList(body)
}

// checkTunnelAddress validates BRINGUP's address: the device's in-tunnel
// IPv4 as Mullvad assigned it — a single /32 inside Mullvad's tunnel space
// and not the gateway/resolver itself. A caller-chosen wider prefix would put
// a connected route for arbitrary space (the Docker subnet, the gateway) on
// wg0.
func checkTunnelAddress(s string) (netip.Prefix, error) {
	p, err := netip.ParsePrefix(s)
	if err != nil || !p.Addr().Is4() || p.Bits() != 32 {
		return netip.Prefix{}, errors.New("address must be an IPv4 /32")
	}
	if !mullvadTunnelNet.Contains(p.Addr()) || p.Addr() == netip.MustParseAddr(mullvadDNS) {
		return netip.Prefix{}, fmt.Errorf("address must be a Mullvad tunnel address in %s", mullvadTunnelNet)
	}
	return p, nil
}
