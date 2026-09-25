import Darwin
import Foundation
import OSLog

/// Intervals visible in Instruments in both Debug and Release builds.
///
/// The milestones below also log their elapsed time under the `perf`
/// category, so a run can be timed from `log stream` without Instruments:
/// `xcrun simctl spawn booted log stream --level debug --predicate
/// 'subsystem == "com.argmax.remote" AND category == "perf"'`.
enum NativePerformance {
    private static let signposts = OSLog(subsystem: "com.argmax.remote", category: .pointsOfInterest)
    static let log = Logger(subsystem: "com.argmax.remote", category: "perf")

    static func measure<T>(_ name: StaticString, _ work: () throws -> T) rethrows -> T {
        let id = OSSignpostID(log: signposts)
        os_signpost(.begin, log: signposts, name: name, signpostID: id)
        defer { os_signpost(.end, log: signposts, name: name, signpostID: id) }
        return try work()
    }

    /// A point in Instruments' Points of Interest track.
    static func event(_ name: StaticString) {
        os_signpost(.event, log: signposts, name: name)
    }

    /// Milliseconds since the kernel started this process, which includes
    /// the pre-main work a clock started in `main` would miss.
    static func millisecondsSinceLaunch() -> Double {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var name: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&name, 4, &info, &size, nil, 0) == 0 else { return 0 }
        let start = info.kp_proc.p_un.__p_starttime
        let started = Double(start.tv_sec) + Double(start.tv_usec) / 1_000_000
        return (Date().timeIntervalSince1970 - started) * 1_000
    }
}

extension Duration {
    /// Whole milliseconds, for the `perf` log lines.
    var milliseconds: Int {
        Int(components.seconds * 1_000 + components.attoseconds / 1_000_000_000_000_000)
    }
}

