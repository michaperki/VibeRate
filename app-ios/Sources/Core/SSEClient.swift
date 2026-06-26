import Foundation

/// A Server-Sent-Events reader for the VibeRate stream routes. The key win over the web
/// app: this sets an `Authorization` header (browser `EventSource` can't), so the native
/// client talks to the admin-guarded `/stream` routes directly — no `?access_token=` hack.
///
/// **Why a `URLSessionDataDelegate` and not `URLSession.bytes(for:).lines`:** `.bytes`
/// buffers a streaming response and doesn't yield lines until the body completes — but an
/// SSE stream never completes, so `for try await line in bytes.lines` hangs forever,
/// delivering zero events while the connection sits open (the "·, nothing ever renders"
/// bug). The delegate gets each `didReceive data` chunk as it arrives, so we parse frames
/// incrementally. This is the standard way to consume SSE on URLSession.
final class SSEClient: NSObject, URLSessionDataDelegate {
    struct Event {
        let id: String?
        let data: String
    }

    /// Fires once with the HTTP status as soon as the response headers arrive — a
    /// diagnostic so the UI can show "connected (200), awaiting events" vs an error code,
    /// distinct from "never connected".
    var onOpen: ((Int) -> Void)?

    /// Fires when a `:` heartbeat comment arrives (the server pings every ~15s between/
    /// within turns). This is the *only* liveness signal during a quiet stretch — events
    /// don't flow but pings do — so the view's watchdog uses it to tell "alive but idle"
    /// from "socket open but silently dead". Fires on the delegate queue.
    var onHeartbeat: (() -> Void)?

    private let url: URL
    private let token: String?
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var continuation: AsyncThrowingStream<Event, Error>.Continuation?

    // SSE frame accumulation (touched only on the delegate's serial queue).
    private var buffer = Data()
    private var curId: String?
    private var curData: [String] = []

    init(url: URL, token: String?) {
        self.url = url
        self.token = token
    }

    func events() -> AsyncThrowingStream<Event, Error> {
        AsyncThrowingStream { continuation in
            self.continuation = continuation

            var req = URLRequest(url: url)
            req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            req.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
            // Refuse compression: URLSession transparently buffers a gzipped body until it
            // can decode a block, which on a slow SSE trickle holds events back. (The server
            // already skips gzip on text/event-stream — this is belt-and-suspenders.)
            req.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
            req.timeoutInterval = 3600
            if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }

            let config = URLSessionConfiguration.default
            config.timeoutIntervalForRequest = 3600
            config.timeoutIntervalForResource = 86_400
            config.waitsForConnectivity = true
            // No caching: the URL loading system can buffer a response body to write it to
            // the cache, delaying the per-chunk delegate callbacks an endless stream needs.
            config.urlCache = nil
            config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
            self.session = session

            let task = session.dataTask(with: req)
            self.task = task
            continuation.onTermination = { [weak self] _ in
                self?.task?.cancel()
                self?.session?.invalidateAndCancel()   // breaks URLSession→delegate retain
            }
            task.resume()
        }
    }

    // MARK: - URLSessionDataDelegate

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        if let http = response as? HTTPURLResponse {
            onOpen?(http.statusCode)
            if !(200..<300).contains(http.statusCode) {
                continuation?.finish(throwing: APIError.http(http.statusCode, "stream rejected"))
                completionHandler(.cancel)
                return
            }
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        buffer.append(data)
        // Drain complete lines (delimited by \n) as they arrive.
        while let nl = buffer.firstIndex(of: 0x0A) {
            let lineData = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            var line = String(data: lineData, encoding: .utf8) ?? ""
            if line.hasSuffix("\r") { line.removeLast() }   // tolerate CRLF
            handle(line)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error { continuation?.finish(throwing: error) }
        else { continuation?.finish() }
    }

    // MARK: - SSE parsing

    private func handle(_ line: String) {
        if line.isEmpty {                       // blank line = dispatch the event
            if !curData.isEmpty {
                continuation?.yield(Event(id: curId, data: curData.joined(separator: "\n")))
            }
            curId = nil
            curData = []
            return
        }
        if line.hasPrefix(":") { onHeartbeat?(); return }   // comment / heartbeat → liveness signal
        if line.hasPrefix("id:") {
            curId = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
        } else if line.hasPrefix("data:") {
            curData.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
        }
    }
}
