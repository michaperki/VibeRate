import Foundation

/// A minimal Server-Sent-Events reader built on `URLSession.bytes`. The key win over
/// the web app: this CAN set an `Authorization` header (browser `EventSource` can't),
/// so the native client talks to the admin-guarded `/stream` route directly — the
/// `?access_token=`-in-URL hack the wrapper needed simply doesn't exist here
/// (PLAN_NATIVE_AUTH.md).
struct SSEClient {
    let url: URL
    let token: String?

    struct Event {
        let id: String?
        let data: String
    }

    func events() -> AsyncThrowingStream<Event, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var req = URLRequest(url: url)
                    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    req.timeoutInterval = 3600
                    if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }

                    let (bytes, resp) = try await URLSession.shared.bytes(for: req)
                    if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                        throw APIError.http(http.statusCode, "stream rejected")
                    }

                    var id: String?
                    var dataLines: [String] = []
                    for try await line in bytes.lines {
                        if line.isEmpty {                       // blank line = dispatch the event
                            if !dataLines.isEmpty {
                                continuation.yield(Event(id: id, data: dataLines.joined(separator: "\n")))
                            }
                            id = nil
                            dataLines = []
                            continue
                        }
                        if line.hasPrefix(":") { continue }     // comment / heartbeat
                        if line.hasPrefix("id:") {
                            id = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                        } else if line.hasPrefix("data:") {
                            dataLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
