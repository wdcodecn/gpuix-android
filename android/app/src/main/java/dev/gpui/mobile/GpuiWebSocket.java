package dev.gpui.mobile;

import android.util.Base64;
import android.util.Log;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Iterator;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.SSLSocketFactory;
import org.json.JSONObject;

/**
 * Zero-dependency RFC 6455 WebSocket client for Hermes JS WebSocket polyfill.
 */
public final class GpuiWebSocket {

    private static final String TAG = "GpuiWebSocket";
    private static final ExecutorService EXECUTOR = Executors.newCachedThreadPool();
    private static final ConcurrentHashMap<Long, WsConn> CONNECTIONS = new ConcurrentHashMap<>();
    private static final SecureRandom RNG = new SecureRandom();

    private static final class WsConn {
        final long id;
        volatile Socket socket;
        volatile OutputStream out;
        volatile boolean closed = false;
        final Object writeLock = new Object();

        WsConn(long id) {
            this.id = id;
        }
    }

    private GpuiWebSocket() {
    }

    public static boolean connect(final long socketId, final String url, final String headersJson) {
        if (url == null || url.isEmpty()) return false;
        WsConn conn = new WsConn(socketId);
        WsConn prev = CONNECTIONS.put(socketId, conn);
        if (prev != null) closeConn(prev, 1000, "replaced");

        EXECUTOR.execute(() -> runConnection(conn, url, headersJson));
        return true;
    }

    public static boolean sendText(final long socketId, final String text) {
        WsConn conn = CONNECTIONS.get(socketId);
        if (conn == null || conn.closed || text == null) return false;
        return writeFrame(conn, 0x1, text.getBytes(StandardCharsets.UTF_8));
    }

    public static boolean sendBinary(final long socketId, final byte[] data) {
        WsConn conn = CONNECTIONS.get(socketId);
        if (conn == null || conn.closed || data == null) return false;
        return writeFrame(conn, 0x2, data);
    }

    public static void close(final long socketId, final int code, final String reason) {
        WsConn conn = CONNECTIONS.remove(socketId);
        if (conn != null) {
            EXECUTOR.execute(() -> closeConn(conn, code, reason));
        }
    }

    public static void closeAll() {
        for (WsConn conn : CONNECTIONS.values()) {
            closeConn(conn, 1001, "shutdown");
        }
        CONNECTIONS.clear();
    }

    private static void closeConn(WsConn conn, int code, String reason) {
        if (conn.closed) return;
        conn.closed = true;
        try {
            byte[] reasonBytes = reason != null ? reason.getBytes(StandardCharsets.UTF_8) : new byte[0];
            int payloadLen = Math.min(123, reasonBytes.length) + 2;
            byte[] payload = new byte[payloadLen];
            payload[0] = (byte) ((code >> 8) & 0xff);
            payload[1] = (byte) (code & 0xff);
            if (payloadLen > 2) {
                System.arraycopy(reasonBytes, 0, payload, 2, payloadLen - 2);
            }
            writeFrame(conn, 0x8, payload);
        } catch (Throwable ignored) {}
        try {
            if (conn.socket != null) conn.socket.close();
        } catch (Throwable ignored) {}
    }

    private static void runConnection(WsConn conn, String url, String headersJson) {
        try {
            URI uri = URI.create(url);
            String scheme = uri.getScheme() != null ? uri.getScheme().toLowerCase() : "ws";
            boolean tls = "wss".equals(scheme) || "https".equals(scheme);
            if (!tls && !"ws".equals(scheme) && !"http".equals(scheme)) {
                emit(conn.id, "error", null, null, 0, "Unsupported WebSocket scheme: " + scheme);
                emit(conn.id, "close", null, null, 1006, "Invalid URL scheme");
                return;
            }
            String host = uri.getHost();
            if (host == null || host.isEmpty()) {
                emit(conn.id, "error", null, null, 0, "Missing WebSocket host");
                emit(conn.id, "close", null, null, 1006, "Missing host");
                return;
            }
            int port = uri.getPort();
            if (port <= 0) port = tls ? 443 : 80;
            String path = (uri.getRawPath() == null || uri.getRawPath().isEmpty()) ? "/" : uri.getRawPath();
            if (uri.getRawQuery() != null && !uri.getRawQuery().isEmpty()) {
                path += "?" + uri.getRawQuery();
            }

            Socket socket;
            if (tls) {
                socket = SSLSocketFactory.getDefault().createSocket();
            } else {
                socket = new Socket();
            }
            socket.connect(new InetSocketAddress(host, port), 10_000);
            socket.setTcpNoDelay(true);
            conn.socket = socket;
            conn.out = socket.getOutputStream();

            byte[] keyBytes = new byte[16];
            RNG.nextBytes(keyBytes);
            String wsKey = Base64.encodeToString(keyBytes, Base64.NO_WRAP);

            StringBuilder req = new StringBuilder();
            req.append("GET ").append(path).append(" HTTP/1.1\r\n");
            req.append("Host: ").append(host);
            if ((tls && port != 443) || (!tls && port != 80)) {
                req.append(':').append(port);
            }
            req.append("\r\n");
            req.append("Upgrade: websocket\r\n");
            req.append("Connection: Upgrade\r\n");
            req.append("Sec-WebSocket-Key: ").append(wsKey).append("\r\n");
            req.append("Sec-WebSocket-Version: 13\r\n");
            if (headersJson != null && !headersJson.isEmpty()) {
                try {
                    JSONObject hdrs = new JSONObject(headersJson);
                    Iterator<String> keys = hdrs.keys();
                    while (keys.hasNext()) {
                        String k = keys.next();
                        req.append(k).append(": ").append(hdrs.optString(k, "")).append("\r\n");
                    }
                } catch (Throwable ignored) {}
            }
            req.append("\r\n");

            conn.out.write(req.toString().getBytes(StandardCharsets.US_ASCII));
            conn.out.flush();

            BufferedInputStream in = new BufferedInputStream(socket.getInputStream());
            String statusLine = readHttpLine(in);
            if (statusLine == null || !statusLine.contains("101")) {
                throw new IOException("Handshake rejected: " + statusLine);
            }
            while (true) {
                String line = readHttpLine(in);
                if (line == null || line.isEmpty()) break;
            }

            emit(conn.id, "open", null, null, 0, null);
            readLoop(conn, in);
        } catch (Throwable t) {
            if (!conn.closed) {
                Log.w(TAG, "WebSocket error id=" + conn.id + ": " + t.getMessage());
                emit(conn.id, "error", null, null, 0, t.getMessage() != null ? t.getMessage() : "WebSocket failure");
                emit(conn.id, "close", null, null, 1006, t.getMessage());
            }
        } finally {
            CONNECTIONS.remove(conn.id, conn);
            try { if (conn.socket != null) conn.socket.close(); } catch (Throwable ignored) {}
        }
    }

    private static void readLoop(WsConn conn, InputStream in) throws IOException {
        ByteArrayOutputStream fragBuf = new ByteArrayOutputStream();
        int fragOpcode = -1;
        while (!conn.closed) {
            int b1 = in.read();
            if (b1 < 0) {
                emit(conn.id, "close", null, null, 1000, "EOF");
                return;
            }
            int b2 = in.read();
            if (b2 < 0) throw new EOFException();
            boolean fin = (b1 & 0x80) != 0;
            int opcode = b1 & 0x0f;
            boolean masked = (b2 & 0x80) != 0;
            long len = b2 & 0x7f;
            if (len == 126) {
                byte[] ext = readExact(in, 2);
                len = ((ext[0] & 0xff) << 8) | (ext[1] & 0xff);
            } else if (len == 127) {
                byte[] ext = readExact(in, 8);
                len = 0;
                for (int i = 0; i < 8; i++) len = (len << 8) | (ext[i] & 0xffL);
            }
            byte[] maskKey = masked ? readExact(in, 4) : null;
            if (len > 16 * 1024 * 1024) throw new IOException("Frame too large: " + len);
            byte[] payload = readExact(in, (int) len);
            if (maskKey != null) {
                for (int i = 0; i < payload.length; i++) {
                    payload[i] = (byte) (payload[i] ^ maskKey[i & 3]);
                }
            }

            if (opcode == 0x8) {
                int closeCode = payload.length >= 2 ? (((payload[0] & 0xff) << 8) | (payload[1] & 0xff)) : 1000;
                String closeReason = payload.length > 2 ? new String(payload, 2, payload.length - 2, StandardCharsets.UTF_8) : "";
                conn.closed = true;
                emit(conn.id, "close", null, null, closeCode, closeReason);
                return;
            } else if (opcode == 0x9) {
                writeFrame(conn, 0xA, payload); // Pong
            } else if (opcode == 0xA) {
                // Ignore Pong
            } else {
                int effOpcode = opcode;
                if (opcode == 0x0 && fragOpcode != -1) {
                    fragBuf.write(payload);
                    effOpcode = fragOpcode;
                } else if (!fin) {
                    fragBuf.reset();
                    fragBuf.write(payload);
                    fragOpcode = opcode;
                    continue;
                } else {
                    fragBuf.reset();
                    fragBuf.write(payload);
                }
                if (fin) {
                    byte[] msgBytes = fragBuf.toByteArray();
                    fragBuf.reset();
                    fragOpcode = -1;
                    if (effOpcode == 0x1) {
                        emit(conn.id, "message", new String(msgBytes, StandardCharsets.UTF_8), null, 0, null);
                    } else if (effOpcode == 0x2) {
                        emit(conn.id, "message", null, msgBytes, 0, null);
                    }
                }
            }
        }
    }

    private static boolean writeFrame(WsConn conn, int opcode, byte[] payload) {
        OutputStream out = conn.out;
        if (out == null) return false;
        synchronized (conn.writeLock) {
            try {
                byte[] mask = new byte[4];
                RNG.nextBytes(mask);
                int len = payload.length;
                out.write(0x80 | (opcode & 0x0f));
                if (len <= 125) {
                    out.write(0x80 | len);
                } else if (len <= 65535) {
                    out.write(0x80 | 126);
                    out.write((len >> 8) & 0xff);
                    out.write(len & 0xff);
                } else {
                    out.write(0x80 | 127);
                    long l = len;
                    for (int shift = 56; shift >= 0; shift -= 8) {
                        out.write((int) ((l >> shift) & 0xff));
                    }
                }
                out.write(mask);
                byte[] masked = new byte[len];
                for (int i = 0; i < len; i++) {
                    masked[i] = (byte) (payload[i] ^ mask[i & 3]);
                }
                out.write(masked);
                out.flush();
                return true;
            } catch (Throwable t) {
                return false;
            }
        }
    }

    private static byte[] readExact(InputStream in, int n) throws IOException {
        byte[] buf = new byte[n];
        int off = 0;
        while (off < n) {
            int r = in.read(buf, off, n - off);
            if (r < 0) throw new EOFException();
            off += r;
        }
        return buf;
    }

    private static String readHttpLine(InputStream in) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        int prev = -1;
        while (true) {
            int c = in.read();
            if (c < 0) return baos.size() == 0 ? null : baos.toString("US-ASCII");
            if (c == '\n') {
                byte[] b = baos.toByteArray();
                int len = (prev == '\r' && b.length > 0) ? b.length - 1 : b.length;
                return new String(b, 0, len, StandardCharsets.US_ASCII);
            }
            baos.write(c);
            prev = c;
        }
    }

    private static void emit(long socketId, String eventType, String textPayload, byte[] binaryPayload, int code, String reason) {
        try {
            nativeWsEvent(socketId, eventType, textPayload, binaryPayload, code, reason);
        } catch (UnsatisfiedLinkError ignored) {
        }
    }

    public static native void nativeWsEvent(long socketId, String eventType, String textPayload, byte[] binaryPayload, int code, String reason);
}
