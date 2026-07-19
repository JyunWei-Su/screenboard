package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// CommandHandler processes a server command and reports success + detail.
type CommandHandler func(cmd ServerCommand) (ok bool, detail string)

// WSClient maintains the persistent command channel with auto-reconnect.
type WSClient struct {
	cfg     *Config
	client  *Client
	handler CommandHandler
	// onStatus reports whether the command channel is currently up. It drives
	// the kiosk's "目前離線" badge, so it flips false the moment the socket drops
	// and true again on reconnect.
	onStatus func(online bool)

	mu              sync.Mutex
	conn            *websocket.Conn
	heartbeatUpdate chan time.Duration
}

func NewWSClient(cfg *Config, client *Client, handler CommandHandler, onStatus func(online bool)) *WSClient {
	return &WSClient{cfg: cfg, client: client, handler: handler, onStatus: onStatus, heartbeatUpdate: make(chan time.Duration, 1)}
}

func (w *WSClient) notifyStatus(online bool) {
	if w.onStatus != nil {
		w.onStatus(online)
	}
}

// Run connects and blocks, reconnecting with backoff until ctx is cancelled.
func (w *WSClient) Run(ctx context.Context) error {
	backoff := time.Second
	for {
		if ctx.Err() != nil {
			return nil
		}
		if err := w.connectAndServe(ctx); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			w.notifyStatus(false)
			log.Printf("ws: %v (retry in %s)", err, backoff)
			t := time.NewTimer(backoff)
			select {
			case <-ctx.Done():
				t.Stop()
				return nil
			case <-t.C:
			}
			if backoff < 30*time.Second {
				backoff *= 2
			}
			continue
		}
		backoff = time.Second
	}
}

func (w *WSClient) connectAndServe(ctx context.Context) error {
	// Authenticate the upgrade with an Authorization header so the token stays
	// out of the URL (and thus out of access logs). The server still accepts a
	// ?token= query for older agents.
	authHeader := func() http.Header {
		return http.Header{"Authorization": {"Bearer " + w.cfg.AccessToken}}
	}
	conn, resp, err := websocket.DefaultDialer.DialContext(ctx, w.cfg.WSURL, authHeader())
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusUnauthorized {
			if rErr := w.client.refresh(); rErr == nil {
				conn, _, err = websocket.DefaultDialer.DialContext(ctx, w.cfg.WSURL, authHeader())
			}
		}
		if err != nil {
			return err
		}
	}
	w.mu.Lock()
	w.conn = conn
	w.mu.Unlock()
	w.notifyStatus(true)
	log.Printf("ws connected")
	serveDone := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = conn.Close() // interrupt ReadMessage so Run can finish shutdown
		case <-serveDone:
		}
	}()
	defer close(serveDone)

	// Heartbeat keeps the DO presence fresh.
	stop := make(chan struct{})
	go w.heartbeat(ctx, stop)
	defer close(stop)
	defer conn.Close()

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		w.dispatch(data)
	}
}

func (w *WSClient) heartbeat(ctx context.Context, stop <-chan struct{}) {
	d := time.Duration(w.cfg.HeartbeatEvery) * time.Second
	t := time.NewTicker(d)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-stop:
			return
		case next := <-w.heartbeatUpdate:
			if next <= 0 {
				continue
			}
			t.Stop()
			t = time.NewTicker(next)
		case <-t.C:
			if err := w.send(Heartbeat{Type: "heartbeat"}); err != nil {
				// A failed heartbeat write means the socket is dead even if the
				// read side hasn't noticed yet (silent network drop). Close it so
				// the read loop unblocks, Run reconnects, and the kiosk shows
				// offline promptly instead of after the TCP timeout.
				w.mu.Lock()
				conn := w.conn
				w.mu.Unlock()
				if conn != nil {
					_ = conn.Close()
				}
				return
			}
		}
	}
}

// SetHeartbeatInterval applies a new heartbeat cadence without reconnecting.
func (w *WSClient) SetHeartbeatInterval(d time.Duration) {
	select {
	case w.heartbeatUpdate <- d:
	default:
		select {
		case <-w.heartbeatUpdate:
		default:
		}
		select {
		case w.heartbeatUpdate <- d:
		default:
		}
	}
}

// Stop breaks any blocking WebSocket read so Run can observe context shutdown.
func (w *WSClient) Stop() {
	w.mu.Lock()
	conn := w.conn
	w.mu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
}

func (w *WSClient) dispatch(data []byte) {
	// Ignore server "welcome"; act on commands.
	var probe struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &probe); err == nil && probe.Type == "welcome" {
		return
	}
	var cmd ServerCommand
	if err := json.Unmarshal(data, &cmd); err != nil || cmd.ID == "" {
		return
	}
	ok, detail := w.handler(cmd)
	_ = w.send(CommandAck{Type: "ack", CommandID: cmd.ID, OK: ok, Detail: detail})
}

func (w *WSClient) send(v interface{}) error {
	w.mu.Lock()
	conn := w.conn
	w.mu.Unlock()
	if conn == nil {
		return nil
	}
	b, _ := json.Marshal(v)
	return conn.WriteMessage(websocket.TextMessage, b)
}

// SendPlayback relays a player event over the channel (best-effort).
func (w *WSClient) SendPlayback(ev PlaybackEvent) { _ = w.send(ev) }
