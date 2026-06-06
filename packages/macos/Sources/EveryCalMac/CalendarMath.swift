import Foundation

struct CalendarDay: Identifiable, Equatable {
    let date: Date
    let isInDisplayedMonth: Bool
    let isToday: Bool

    var id: Date { date }
}

enum CalendarMath {
    static let calendar: Calendar = {
        var cal = Calendar.autoupdatingCurrent
        cal.firstWeekday = 1
        return cal
    }()

    static func startOfDay(_ date: Date) -> Date {
        calendar.startOfDay(for: date)
    }

    static func monthGrid(containing date: Date) -> [CalendarDay] {
        guard
            let monthInterval = calendar.dateInterval(of: .month, for: date),
            let firstWeek = calendar.dateInterval(of: .weekOfMonth, for: monthInterval.start)
        else { return [] }

        let endOfMonth = monthInterval.end.addingTimeInterval(-1)
        let lastWeek = calendar.dateInterval(of: .weekOfMonth, for: endOfMonth)?.end ?? monthInterval.end
        var days: [CalendarDay] = []
        var cursor = firstWeek.start
        while cursor < lastWeek {
            days.append(
                CalendarDay(
                    date: cursor,
                    isInDisplayedMonth: calendar.isDate(cursor, equalTo: date, toGranularity: .month),
                    isToday: calendar.isDateInToday(cursor)
                )
            )
            cursor = calendar.date(byAdding: .day, value: 1, to: cursor) ?? lastWeek
        }
        return days
    }

    static func week(containing date: Date) -> [Date] {
        guard let interval = calendar.dateInterval(of: .weekOfYear, for: date) else { return [] }
        return (0..<7).compactMap { calendar.date(byAdding: .day, value: $0, to: interval.start) }
    }

    static func events(_ events: [EveryCalEvent], on day: Date) -> [EveryCalEvent] {
        events
            .filter { calendar.isDate($0.startInstant, inSameDayAs: day) }
            .sorted { $0.startInstant < $1.startInstant }
    }

    static func events(_ events: [EveryCalEvent], matching query: String, tag: String?) -> [EveryCalEvent] {
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return events.filter { event in
            let matchesTag = tag == nil || event.tags.contains(tag!)
            guard matchesTag else { return false }
            guard !normalizedQuery.isEmpty else { return true }
            return event.title.lowercased().contains(normalizedQuery)
                || (event.description ?? "").lowercased().contains(normalizedQuery)
                || (event.location?.name ?? "").lowercased().contains(normalizedQuery)
        }
    }

    static func visibleRange(for date: Date, mode: CalendarViewMode) -> (from: Date, to: Date) {
        switch mode {
        case .month:
            let days = monthGrid(containing: date)
            return (days.first?.date ?? date, calendar.date(byAdding: .day, value: 1, to: days.last?.date ?? date) ?? date)
        case .week:
            let days = week(containing: date)
            return (days.first ?? date, calendar.date(byAdding: .day, value: 1, to: days.last ?? date) ?? date)
        case .day, .inbox:
            return (startOfDay(date), calendar.date(byAdding: .day, value: 1, to: startOfDay(date)) ?? date)
        case .agenda:
            return (startOfDay(date), calendar.date(byAdding: .month, value: 3, to: startOfDay(date)) ?? date)
        }
    }
}
