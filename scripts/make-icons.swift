// Draws the app and extension icons: a white bookmark on a blue rounded
// square. Run from the repository root with `swift scripts/make-icons.swift`;
// it rewrites the PNGs of the macOS asset catalog and both extensions.
// The shape is our own drawing, not an SF Symbol: Apple's license does not
// allow SF Symbols in app icons.

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
let top = CGColor(srgbRed: 74 / 255, green: 163 / 255, blue: 1, alpha: 1)
let bottom = CGColor(srgbRed: 12 / 255, green: 99 / 255, blue: 229 / 255, alpha: 1)

// Superellipse, close to Apple's continuous-corner app icon shape.
func squircle(_ r: CGRect, exponent n: CGFloat = 5) -> CGPath {
    let path = CGMutablePath()
    let steps = 720
    for i in 0...steps {
        let t = CGFloat(i) / CGFloat(steps) * 2 * .pi
        let c = cos(t), s = sin(t)
        let x = r.midX + r.width / 2 * (c < 0 ? -1 : 1) * pow(abs(c), 2 / n)
        let y = r.midY + r.height / 2 * (s < 0 ? -1 : 1) * pow(abs(s), 2 / n)
        i == 0 ? path.move(to: CGPoint(x: x, y: y)) : path.addLine(to: CGPoint(x: x, y: y))
    }
    path.closeSubpath()
    return path
}

// Bookmark ribbon centred in `box`; `scale` enlarges it for tiny sizes.
func ribbon(in box: CGRect, scale: CGFloat) -> CGPath {
    let w = box.width * 0.36 * scale, h = box.height * 0.50 * scale
    let x0 = box.midX - w / 2, x1 = box.midX + w / 2
    let yTop = box.midY + h / 2, yBottom = box.midY - h / 2
    let radius = w * 0.18, notch = h * 0.24
    let path = CGMutablePath()
    path.move(to: CGPoint(x: x0, y: yBottom))
    path.addLine(to: CGPoint(x: x0, y: yTop - radius))
    path.addArc(tangent1End: CGPoint(x: x0, y: yTop), tangent2End: CGPoint(x: x0 + radius, y: yTop), radius: radius)
    path.addLine(to: CGPoint(x: x1 - radius, y: yTop))
    path.addArc(tangent1End: CGPoint(x: x1, y: yTop), tangent2End: CGPoint(x: x1, y: yTop - radius), radius: radius)
    path.addLine(to: CGPoint(x: x1, y: yBottom))
    path.addLine(to: CGPoint(x: box.midX, y: yBottom + notch))
    path.closeSubpath()
    return path
}

enum Style {
    case mac      // macOS grid: 824/1024 shape with a drop shadow
    case browser  // extension icon with transparent padding (fraction of each side)
}

func render(pixels: Int, style: Style, padding: CGFloat = 0) -> CGImage {
    let ctx = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0, space: srgb,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let size = CGFloat(pixels)
    let shape: CGRect
    switch style {
    case .mac:
        let inset = size * 100 / 1024
        shape = CGRect(x: inset, y: inset, width: size - 2 * inset, height: size - 2 * inset)
    case .browser:
        let inset = max(size * padding, size * 0.03)
        shape = CGRect(x: inset, y: inset, width: size - 2 * inset, height: size - 2 * inset)
    }
    let outline = squircle(shape)

    if case .mac = style {
        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: -size * 0.012), blur: size * 0.03,
                      color: CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.3))
        ctx.addPath(outline)
        ctx.setFillColor(bottom)
        ctx.fillPath()
        ctx.restoreGState()
    }

    ctx.saveGState()
    ctx.addPath(outline)
    ctx.clip()
    let gradient = CGGradient(colorsSpace: srgb, colors: [top, bottom] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(gradient, start: CGPoint(x: 0, y: shape.maxY), end: CGPoint(x: 0, y: shape.minY), options: [])
    ctx.restoreGState()

    let tiny = shape.width <= 32
    ctx.addPath(ribbon(in: shape, scale: tiny ? 1.18 : 1))
    ctx.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
    ctx.fillPath()
    return ctx.makeImage()!
}

func write(_ image: CGImage, to path: String) {
    let url = URL(fileURLWithPath: path)
    let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { fatalError("could not write \(path)") }
    print(path)
}

// macOS asset catalog
let appIcon = "macos-app/BookmarksSync/Assets.xcassets/AppIcon.appiconset"
var images: [[String: String]] = []
for points in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let name = "mac-icon-\(points)@\(scale)x.png"
        write(render(pixels: points * scale, style: .mac), to: "\(appIcon)/\(name)")
        images.append(["idiom": "mac", "size": "\(points)x\(points)", "scale": "\(scale)x", "filename": name])
    }
}
let catalog: [String: Any] = ["images": images, "info": ["author": "xcode", "version": 1]]
let json = try JSONSerialization.data(withJSONObject: catalog, options: [.prettyPrinted, .sortedKeys])
try json.write(to: URL(fileURLWithPath: "\(appIcon)/Contents.json"))

// Browser extensions: toolbar sizes fill the square, larger ones keep the
// transparent margin the Chrome Web Store asks for (16 of 128 px per side).
for browser in ["chrome", "firefox"] {
    for pixels in [16, 32, 48, 96, 128] {
        let padding: CGFloat = pixels <= 32 ? 0 : 0.125
        write(render(pixels: pixels, style: .browser, padding: padding), to: "\(browser)-extension/icons/icon\(pixels).png")
    }
}
