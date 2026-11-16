// lcsc-proxy — tiny local CORS relay for the experimental LCSC/JLC part crawler in PCB RevEng.
//
// Single static executable, standard library only: no install, no runtime, no dependencies.
//
//	lcsc-proxy [port]        (default 25615, listens on 127.0.0.1 only)
//
// In the app (Options -> Experimental -> Parts crawler) the Proxy URL defaults to
// http://localhost:25615/?url={url}. Only the hosts in allowedHosts are relayed;
// everything else is answered with 403.
package main

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"time"
)

const defaultPort = 25615

var allowedHosts = map[string]bool{
	"easyeda.com":       true,
	"wmsc.lcsc.com":     true,
	"assets.lcsc.com":   true,
	"image.easyeda.com": true,
}

var client = &http.Client{
	Timeout: 30 * time.Second,
	// never follow a redirect off the allow-list
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if req.URL.Scheme != "https" || !allowedHosts[req.URL.Hostname()] {
			return fmt.Errorf("redirect to a host that is not allowed: %s", req.URL.Host)
		}
		if len(via) >= 5 {
			return fmt.Errorf("too many redirects")
		}
		return nil
	},
}

func setCORS(h http.Header) {
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Headers", "*")
	h.Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	// Chrome's Private Network Access: an https page (e.g. GitHub Pages) calling localhost
	h.Set("Access-Control-Allow-Private-Network", "true")
	h.Set("Access-Control-Max-Age", "600")
}

func handle(w http.ResponseWriter, r *http.Request) {
	setCORS(w.Header())
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	target, err := url.Parse(r.URL.Query().Get("url"))
	if err != nil || target.Scheme != "https" || !allowedHosts[target.Hostname()] {
		http.Error(w, "host not allowed", http.StatusForbidden)
		return
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target.String(), nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	req.Header.Set("User-Agent", "pcb-reveng-crawler")
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func main() {
	port := defaultPort
	if len(os.Args) > 1 {
		p, err := strconv.Atoi(os.Args[1])
		if err != nil || p < 1 || p > 65535 {
			fmt.Fprintln(os.Stderr, "usage: lcsc-proxy [port]")
			os.Exit(2)
		}
		port = p
	}
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		fmt.Fprintf(os.Stderr, "Cannot listen on port %d: %v\nIs it already running? Or pick another port:  lcsc-proxy 9000\n", port, err)
		os.Exit(1)
	}
	fmt.Printf("PCB RevEng LCSC proxy running — http://localhost:%d/?url={url}\n", port)
	fmt.Println("Leave this window open while using the parts crawler; close it (or Ctrl+C) to stop.")
	srv := &http.Server{Handler: http.HandlerFunc(handle), ReadHeaderTimeout: 10 * time.Second}
	if err := srv.Serve(ln); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
