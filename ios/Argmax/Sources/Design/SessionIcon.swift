import SwiftUI
import UIKit

// The glyph and the colour a chat wears, as the desktop's icon picker set them.
//
// `workspaces.icon` holds a curated Lucide name and `workspaces.icon_color` a
// palette *token* — "violet", not a hex value — so one pick reads right on
// both grounds. Both are resolved here rather than at the row, because both
// are wire vocabulary the phone translates: Lucide has no iOS build, and the
// palette's two values per token live in `src/renderer/styles/tokens.css`.
//
// A name this build has never heard of resolves to nil and the row falls
// through to the provider mark. That is the common case for a while yet —
// the desktop offers 262 icons and SF Symbols has no counterpart for a fair
// share of them (an anvil, a squirrel) — and it is why the column's rule is
// written as a fall-through rather than as a lookup that must succeed.

enum SessionIcon {
    /// Lucide name → SF Symbol. Only entries whose symbol exists on the
    /// deployment target belong here; `SessionIconTests` fails the suite for
    /// one that does not, because a missing symbol draws nothing at all and
    /// a blank column is worse than the provider's mark.
    ///
    /// Two Lucide names sharing a symbol is allowed and happens (Landmark and
    /// School are both `building.columns`): the picker's grid is finer than
    /// SF Symbols' vocabulary, and the near miss still says more about the
    /// chat than a fall-through would.
    static let symbols: [String: String] = [
        "Activity": "waveform.path.ecg",
        "AlarmClock": "alarm",
        "Album": "square.stack",
        "Aperture": "camera.aperture",
        "Archive": "archivebox",
        "Armchair": "chair.lounge",
        "Atom": "atom",
        "Award": "rosette",
        "Backpack": "backpack",
        "Banknote": "banknote",
        "Battery": "battery.100percent",
        "Bell": "bell",
        "Bike": "bicycle",
        "Binoculars": "binoculars",
        "Bird": "bird",
        "Blocks": "square.grid.2x2",
        "Bolt": "gearshape.2",
        "Book": "book",
        "BookOpen": "book.pages",
        "Bookmark": "bookmark",
        "Box": "shippingbox",
        "Boxes": "square.stack.3d.up",
        "Brain": "brain",
        "Briefcase": "briefcase",
        "Bug": "ant",
        "Building2": "building.2",
        "Cable": "cable.connector",
        "Cake": "birthday.cake",
        "Calculator": "plus.forwardslash.minus",
        "Calendar": "calendar",
        "Camera": "camera",
        "Car": "car",
        "Cat": "cat",
        "ChartColumn": "chart.bar",
        "ChartLine": "chart.line.uptrend.xyaxis",
        "ChartPie": "chart.pie",
        "Check": "checkmark",
        "CircuitBoard": "memorychip",
        "Clapperboard": "movieclapper",
        "ClipboardList": "list.clipboard",
        "Clock": "clock",
        "Cloud": "cloud",
        "Code": "chevron.left.forwardslash.chevron.right",
        "Coffee": "cup.and.saucer",
        "Cog": "gearshape",
        "Compass": "safari",
        "Component": "puzzlepiece.extension",
        "Cpu": "cpu",
        "CreditCard": "creditcard",
        "Crosshair": "scope",
        "Crown": "crown",
        "Database": "cylinder",
        "Diamond": "diamond",
        "Dices": "dice",
        "Disc": "opticaldisc",
        "Dog": "dog",
        "DollarSign": "dollarsign",
        "Drama": "theatermasks",
        "Droplet": "drop",
        "Dumbbell": "dumbbell",
        "Earth": "globe.americas",
        "Eye": "eye",
        "Fan": "fan",
        "FileCode": "doc.plaintext",
        "FileText": "doc.text",
        "Filter": "line.3.horizontal.decrease",
        "Fish": "fish",
        "Flag": "flag",
        "Flame": "flame",
        "Flower": "camera.macro",
        "Focus": "viewfinder",
        "Folder": "folder",
        "Footprints": "shoeprints.fill",
        "Fuel": "fuelpump",
        "Gamepad2": "gamecontroller",
        "Gauge": "speedometer",
        "Gem": "diamond.inset.filled",
        "Gift": "gift",
        "GitBranch": "arrow.triangle.branch",
        "Glasses": "eyeglasses",
        "Globe": "globe",
        "GraduationCap": "graduationcap",
        "Guitar": "guitars",
        "Hammer": "hammer",
        "Hand": "hand.raised",
        "HardDrive": "internaldrive",
        "Headphones": "headphones",
        "Heart": "heart",
        "Hexagon": "hexagon",
        "Highlighter": "highlighter",
        "Hourglass": "hourglass",
        "House": "house",
        "Image": "photo",
        "Inbox": "tray",
        "Key": "key",
        "Keyboard": "keyboard",
        "Lamp": "lamp.desk",
        "Landmark": "building.columns",
        "Laptop": "laptopcomputer",
        "Layers": "square.3.layers.3d",
        "Leaf": "leaf",
        "Library": "books.vertical",
        "LifeBuoy": "lifepreserver",
        "Lightbulb": "lightbulb",
        "Link": "link",
        "Locate": "location",
        "Lock": "lock",
        "Luggage": "suitcase",
        "Map": "map",
        "Medal": "medal",
        "Megaphone": "megaphone",
        "MessageSquare": "bubble.left",
        "Mic": "mic",
        "Milestone": "flag.checkered",
        "Monitor": "display",
        "Moon": "moon",
        "Mountain": "mountain.2",
        "Mouse": "computermouse",
        "Music": "music.note",
        "Navigation": "location.north",
        "Network": "network",
        "Newspaper": "newspaper",
        "Notebook": "book.closed",
        "Package": "cube",
        "Paintbrush": "paintbrush",
        "Palette": "paintpalette",
        "Paperclip": "paperclip",
        "PartyPopper": "party.popper",
        "PenTool": "pencil.tip",
        "Pencil": "pencil",
        "Pin": "pin",
        "Plane": "airplane",
        "Plug": "powerplug",
        "Podcast": "waveform.circle",
        "Popcorn": "popcorn",
        "Presentation": "chart.bar.doc.horizontal",
        "Printer": "printer",
        "Puzzle": "puzzlepiece",
        "Radar": "dot.radiowaves.up.forward",
        "Radio": "radio",
        "Recycle": "arrow.3.trianglepath",
        "Regex": "curlybraces",
        "Route": "arrow.triangle.turn.up.right.diamond",
        "Ruler": "ruler",
        "Sailboat": "sailboat",
        "Scale": "scalemass",
        "Scan": "doc.viewfinder",
        "School": "building.columns",
        "Scissors": "scissors",
        "Scroll": "scroll",
        "Search": "magnifyingglass",
        "Send": "paperplane",
        "Server": "server.rack",
        "Settings": "slider.horizontal.3",
        "Shapes": "square.on.circle",
        "ShieldCheck": "checkmark.shield",
        "Ship": "ferry",
        "ShoppingBag": "bag",
        "ShoppingCart": "cart",
        "Signal": "cellularbars",
        "Signpost": "signpost.right",
        "Smartphone": "iphone",
        "Smile": "face.smiling",
        "Snowflake": "snowflake",
        "Sofa": "sofa",
        "Sparkles": "sparkles",
        "Speaker": "speaker.wave.2",
        "Split": "rectangle.split.2x1",
        "Star": "star",
        "Stethoscope": "stethoscope",
        "StickyNote": "note.text",
        "Store": "storefront",
        "Sun": "sun.max",
        "Sunrise": "sunrise",
        "Sunset": "sunset",
        "Syringe": "syringe",
        "Table": "tablecells",
        "Tag": "tag",
        "Target": "target",
        "Tent": "tent",
        "Terminal": "terminal",
        "TestTube": "testtube.2",
        "Thermometer": "thermometer.medium",
        "ThumbsUp": "hand.thumbsup",
        "Ticket": "ticket",
        "Timer": "timer",
        "Tornado": "tornado",
        "TrafficCone": "cone",
        "TrainFront": "tram",
        "TreePine": "tree",
        "TrendingUp": "arrow.up.right",
        "Trophy": "trophy",
        "Truck": "truck.box",
        "Tv": "tv",
        "Umbrella": "umbrella",
        "Usb": "cable.connector.horizontal",
        "Users": "person.2",
        "Vault": "lock.shield",
        "Video": "video",
        "Volume2": "speaker.wave.3",
        "Vote": "checkmark.square",
        "Wand": "wand.and.stars",
        "Watch": "applewatch",
        "Waves": "water.waves",
        "Webhook": "point.3.connected.trianglepath.dotted",
        "Wifi": "wifi",
        "Wind": "wind",
        "Wine": "wineglass",
        "Wrench": "wrench",
        "Zap": "bolt"
    ]

    /// The SF Symbol for a picked icon, or nil when there is no pick, no
    /// mapping, or no such symbol on this OS.
    ///
    /// The last of those matters: a symbol that was renamed out from under
    /// this table would otherwise draw an empty 18pt hole in every row that
    /// picked it, where falling through costs nothing.
    static func symbol(for icon: String?) -> String? {
        guard let icon, let symbol = symbols[icon], UIImage(systemName: symbol) != nil else { return nil }
        return symbol
    }

    /// The nine palette tokens, light then dark, from
    /// `--session-icon-<name>` in `tokens.css`. Copied rather than derived:
    /// dark is not a formula applied to light there either — the hues are
    /// re-lit for charcoal — so a generated pair would disagree with the Mac.
    private static let palette: [String: UIColor] = [
        "green": Theme.dynamic(light: 0x4F_8A_63, dark: 0x7F_B4_94),
        "teal": Theme.dynamic(light: 0x2F_80_79, dark: 0x63_B3_AA),
        "blue": Theme.dynamic(light: 0x3F_7F_D8, dark: 0x8A_AE_F2),
        "violet": Theme.dynamic(light: 0x7B_56_D6, dark: 0xB3_92_F0),
        "plum": Theme.dynamic(light: 0xA1_51_9C, dark: 0xD6_8E_CF),
        "clay": Theme.dynamic(light: 0xB5_6A_4A, dark: 0xDD_9A_76),
        "amber": Theme.dynamic(light: 0xB5_87_2F, dark: 0xD9_A5_66),
        "pink": Theme.dynamic(light: 0xC4_52_7D, dark: 0xEC_8B_AD),
        "red": Theme.dynamic(light: 0xC8_41_51, dark: 0xF0_70_7F)
    ]

    /// The colour a chat picked, or nil when it picked none. Nil rather than
    /// the desktop's blue default: the caller's fallback is the accent, and
    /// substituting a colour here would make every row look chosen.
    static func color(for token: String?) -> Color? {
        guard let token, let color = palette[token] else { return nil }
        return Color(color)
    }
}
