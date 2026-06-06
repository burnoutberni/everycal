import Foundation

enum EveryCalAPIError: LocalizedError {
    case invalidServer
    case notAuthenticated
    case badResponse(Int, String)
    case decodingFailed

    var errorDescription: String? {
        switch self {
        case .invalidServer: "Enter a valid EveryCal server URL."
        case .notAuthenticated: "Sign in to your EveryCal account first."
        case .badResponse(let status, let message): "EveryCal returned \(status): \(message)"
        case .decodingFailed: "The EveryCal response could not be decoded."
        }
    }
}

@MainActor
final class EveryCalAPI: ObservableObject {
    @Published var serverURL: URL

    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    init(serverURL: URL = URL(string: "https://everycal.localhost")!) {
        self.serverURL = serverURL
        let configuration = URLSessionConfiguration.default
        configuration.httpCookieAcceptPolicy = .always
        configuration.httpShouldSetCookies = true
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.session = URLSession(configuration: configuration)
        self.decoder = JSONDecoder()
        self.encoder = JSONEncoder()
    }

    func updateServer(_ rawValue: String) throws {
        guard let url = URL(string: rawValue), ["http", "https"].contains(url.scheme?.lowercased()) else {
            throw EveryCalAPIError.invalidServer
        }
        serverURL = url
    }

    func login(username: String, password: String) async throws -> AuthResponse {
        try await request(
            "/auth/login",
            method: "POST",
            body: ["username": username, "password": password]
        )
    }

    func logout() async throws {
        let _: EmptyResponse = try await request("/auth/logout", method: "POST")
    }

    func me() async throws -> EveryCalUser {
        try await request("/auth/me")
    }

    func listEvents(from: Date, to: Date, scope: String = "mine", query: String = "") async throws -> EventsResponse {
        var components = URLComponents(url: endpoint("/events"), resolvingAgainstBaseURL: false)
        var queryItems = [
            URLQueryItem(name: "from", value: ISO8601DateFormatter.everycal.string(from: from)),
            URLQueryItem(name: "to", value: ISO8601DateFormatter.everycal.string(from: to)),
            URLQueryItem(name: "scope", value: scope),
            URLQueryItem(name: "limit", value: "500")
        ]
        if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            queryItems.append(URLQueryItem(name: "q", value: query))
        }
        components?.queryItems = queryItems
        guard let url = components?.url else { throw EveryCalAPIError.invalidServer }
        return try await request(url: url)
    }

    func createEvent(_ payload: EventInputPayload) async throws -> EveryCalEvent {
        try await request("/events", method: "POST", body: payload)
    }

    func updateEvent(id: String, payload: EventInputPayload) async throws -> EveryCalEvent {
        try await request("/events/\(id)", method: "PUT", body: payload)
    }

    func deleteEvent(id: String) async throws {
        let _: EmptyResponse = try await request("/events/\(id)", method: "DELETE")
    }

    func rsvp(eventURI: String, status: RSVPStatus?) async throws {
        let payload = RSVPRequest(eventUri: eventURI, status: status?.rawValue)
        let _: EmptyResponse = try await request("/events/rsvp", method: "POST", body: payload)
    }

    private func endpoint(_ path: String) -> URL {
        serverURL.appending(path: "/api/v1\(path)")
    }

    private func request<T: Decodable>(_ path: String, method: String = "GET") async throws -> T {
        try await request(url: endpoint(path), method: method, bodyData: nil)
    }

    private func request<T: Decodable, Body: Encodable>(_ path: String, method: String = "GET", body: Body) async throws -> T {
        let data = try encoder.encode(body)
        return try await request(url: endpoint(path), method: method, bodyData: data)
    }

    private func request<T: Decodable>(url: URL, method: String = "GET", bodyData: Data? = nil) async throws -> T {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = bodyData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if bodyData != nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw EveryCalAPIError.decodingFailed }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(APIErrorResponse.self, from: data).error) ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            throw EveryCalAPIError.badResponse(http.statusCode, message)
        }
        if T.self == EmptyResponse.self {
            return EmptyResponse() as! T
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw EveryCalAPIError.decodingFailed
        }
    }
}

private struct APIErrorResponse: Decodable {
    let error: String
}

private struct EmptyResponse: Codable {}

private struct RSVPRequest: Codable {
    let eventUri: String
    let status: String?
}
