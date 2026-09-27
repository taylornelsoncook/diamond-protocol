import SwiftUI

/// Diamond Protocol design tokens (same values as the web design system).
enum Theme {
    static let black = Color(red: 0, green: 0, blue: 0)
    static let ground = Color(red: 0x0B / 255, green: 0x0C / 255, blue: 0x0C / 255)
    static let surface = Color(red: 0x16 / 255, green: 0x18 / 255, blue: 0x17 / 255)
    static let line = Color(red: 0x2C / 255, green: 0x30 / 255, blue: 0x2E / 255)
    static let steel = Color(red: 0xE4 / 255, green: 0xE7 / 255, blue: 0xE5 / 255)
    static let muted = Color(red: 0x9A / 255, green: 0xA1 / 255, blue: 0x9D / 255)
    static let green = Color(red: 0x2F / 255, green: 0x6B / 255, blue: 0x34 / 255)
    static let greenBright = Color(red: 0x7D / 255, green: 0xBA / 255, blue: 0x70 / 255)
    static let amber = Color(red: 0xF0 / 255, green: 0xB4 / 255, blue: 0x58 / 255)

    /// Squared display type for titles and big numbers.
    static func display(_ size: CGFloat) -> Font { .system(size: size, weight: .bold, design: .default).width(.condensed) }
}

struct PrimaryButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .frame(maxWidth: .infinity, minHeight: 56)
            .background(Theme.green.opacity(configuration.isPressed ? 0.8 : 1))
            .foregroundStyle(.white)
            .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

struct Panel<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 12) { content }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface)
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line))
            .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}
