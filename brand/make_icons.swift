// Builds every app icon, tile and splash from the owner's logo: brand/source/tamtim-logo.pdf.
//
//     swift brand/make_icons.swift            (from the repository root; needs only macOS)
//
// The source is a VECTOR pdf, so every size is rendered from the artwork itself - nothing is
// enlarged from a bitmap. That is what lets us ship a sharp 1024 px store icon and a clean
// one-colour notification badge, neither of which the old raster logo could give us.
//
// The logo is two pieces on a cream panel: the smiley speech bubble (the MARK), and the whole
// lockup of bubble + تمتم + Tamtim (the LOCKUP). The mark alone is what goes on an icon, because
// at 32 px a word is a smudge and a face is still a face. The rectangles below were measured off
// the rendered page by connected-component analysis; re-measure them if the source file changes.
//
// The logo is never redrawn, only placed. Its three colours are read from the file itself.

import Foundation
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers

let SRC = "brand/source/tamtim-logo.pdf"

// Rectangles in PDF points, y measured from the TOP of the page (1920 x 1080).
let MARK = CGRect(x: 767.8, y: 373.2, width: 194.2, height: 211.5)      // the smiley speech bubble
let LOCKUP = CGRect(x: 767.5, y: 373.5, width: 478.5, height: 348.5)    // bubble + تمتم + Tamtim

// The three colours in the file, measured from it.
let CREAM = (r: 242.0, g: 241.0, b: 235.0)   // #F2F1EB - the panel the logo is drawn on
let GREEN = (r: 31.0, g: 77.0, b: 63.0)      // #1F4D3F - the strokes (and the app's own --color-green)
let AMBER = (r: 232.0, g: 163.0, b: 61.0)    // #E8A33D - the eyes, the smile, the dots

// Backgrounds the app already uses, so an icon sits in the same world as the screen behind it.
let PAPER = rgb(0xF5, 0xF1, 0xE8)            // the app's own paper, a hair warmer than the file's cream
let NIGHT = rgb(0x0D, 0x14, 0x11)            // the dark theme's page colour
let SPLASH_LIGHT = PAPER                     // the splash and the app behind it are the same paper

func rgb(_ r: Int, _ g: Int, _ b: Int) -> CGColor {
    CGColor(red: CGFloat(r)/255, green: CGFloat(g)/255, blue: CGFloat(b)/255, alpha: 1)
}

// ---- rendering ---------------------------------------------------------------------------------

let doc = CGPDFDocument(URL(fileURLWithPath: SRC) as CFURL)!
let page = doc.page(at: 1)!
let pageBox = page.getBoxRect(.cropBox)

func bitmap(_ w: Int, _ h: Int) -> CGContext {
    let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpaceCreateDeviceRGB(),
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.interpolationQuality = .high
    return ctx
}

/// Renders one rectangle of the logo at `pxW` pixels wide and lifts it off its cream panel:
/// the result is transparent everywhere the panel showed through, so it can be placed on any
/// background. Each pixel is matched against the two inks - a stroke keeps the colour and the
/// softness (anti-aliasing) it was drawn with. `tint`, when given, paints every stroke one colour.
func inkImage(_ r: CGRect, pxW: Int, tint: (r: Double, g: Double, b: Double)? = nil) -> CGImage {
    let scale = CGFloat(pxW) / r.width
    let w = pxW, h = Int((r.height * scale).rounded())
    let ctx = bitmap(w, h)
    ctx.setFillColor(red: CGFloat(CREAM.r)/255, green: CGFloat(CREAM.g)/255, blue: CGFloat(CREAM.b)/255, alpha: 1)
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    ctx.scaleBy(x: scale, y: scale)
    ctx.translateBy(x: -r.origin.x, y: -(pageBox.height - r.origin.y - r.height))  // pdf origin is bottom-left
    ctx.drawPDFPage(page)

    let bpr = ctx.bytesPerRow
    let p = ctx.data!.bindMemory(to: UInt8.self, capacity: bpr * h)
    /// How much of `ink` is in this pixel, if the pixel is ink over cream - and how wrong that guess is.
    func coverage(_ px: (Double, Double, Double), _ ink: (r: Double, g: Double, b: Double)) -> (a: Double, err: Double) {
        let d = (CREAM.r - ink.r, CREAM.g - ink.g, CREAM.b - ink.b)
        let n = d.0*d.0 + d.1*d.1 + d.2*d.2
        let a = max(0, min(1, ((CREAM.r - px.0)*d.0 + (CREAM.g - px.1)*d.1 + (CREAM.b - px.2)*d.2) / n))
        let e = (CREAM.r - a*d.0 - px.0, CREAM.g - a*d.1 - px.1, CREAM.b - a*d.2 - px.2)
        return (a, e.0*e.0 + e.1*e.1 + e.2*e.2)
    }
    for y in 0..<h {
        for x in 0..<w {
            let o = y*bpr + x*4
            let px = (Double(p[o]), Double(p[o+1]), Double(p[o+2]))
            let g = coverage(px, GREEN), a = coverage(px, AMBER)
            let (alpha, colour) = g.err <= a.err ? (g.a, GREEN) : (a.a, AMBER)
            let c = tint ?? colour
            p[o] = UInt8((c.r * alpha).rounded())          // premultiplied
            p[o+1] = UInt8((c.g * alpha).rounded())
            p[o+2] = UInt8((c.b * alpha).rounded())
            p[o+3] = UInt8((alpha * 255).rounded())
        }
    }
    return ctx.makeImage()!
}

func write(_ img: CGImage, _ path: String) {
    try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent,
                                             withIntermediateDirectories: true)
    let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL,
                                               UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, img, nil)
    CGImageDestinationFinalize(dest)
    print("  \(path)  \(img.width)x\(img.height)")
}

/// Places a rectangle of the logo in the middle of a square, filling `fraction` of its side.
/// `background` nil leaves the square transparent (Android's foreground layer, the mono badge).
/// `invert` turns the green strokes cream and keeps the amber, for a dark tile.
func square(_ side: Int, _ r: CGRect, fraction: CGFloat, background: CGColor?,
            tint: (r: Double, g: Double, b: Double)? = nil, invert: Bool = false) -> CGImage {
    let ctx = bitmap(side, side)
    if let bg = background { ctx.setFillColor(bg); ctx.fill(CGRect(x: 0, y: 0, width: side, height: side)) }
    // Fit by the longer side so the mark never overflows, whichever way round it is.
    let box = CGFloat(side) * fraction
    let k = min(box / r.width, box / r.height)
    let w = r.width * k, h = r.height * k
    // Oversample 3x before the final placement: these are small icons and the strokes are thin.
    let px = max(64, Int(w * 3))
    let img = invert ? inkImageDark(r, pxW: px) : inkImage(r, pxW: px, tint: tint)
    ctx.draw(img, in: CGRect(x: (CGFloat(side) - w)/2, y: (CGFloat(side) - h)/2, width: w, height: h))
    return ctx.makeImage()!
}


// ---- the icons ---------------------------------------------------------------------------------

print("web/public/app-icons:")
let WEB = "web/public/app-icons"
// Full-bleed: a phone rounds the corners itself, so the icon is a square of the logo's own cream.
for (name, size) in [("icon-512.png", 512), ("icon-192.png", 192), ("apple-touch-icon.png", 180),
                     ("favicon-32.png", 32)] {
    write(square(size, MARK, fraction: 0.74, background: PAPER), "\(WEB)/\(name)")
}
// Maskable: Android may crop this to a circle, so the mark stays inside the safe middle.
write(square(512, MARK, fraction: 0.56, background: PAPER), "\(WEB)/icon-maskable-512.png")
// The notification badge: Android throws the colours away and keeps the shape, so give it one colour.
// It stays an outline rather than a filled blob: the bubble is drawn with gaps (the chin is a separate
// stroke), so there is no inside to fill - and at 24 px the ring with its two eyes still reads as this logo.
write(square(96, MARK, fraction: 0.86, background: nil, tint: (255, 255, 255)), "\(WEB)/icon-mono-96.png")

// The tile the app itself shows (the header and the sign-in screen) is imported by the code, not
// fetched by name: the bundler gives it a content-hashed filename, so a new logo reaches people the
// moment they load the page. A fixed name under the document root would not - see docs/DEPLOY.md.
write(square(320, MARK, fraction: 0.74, background: PAPER), "web/src/brand/logo-tile.png")

print("mobile/assets:")
let APP = "mobile/assets"
write(square(1024, MARK, fraction: 0.74, background: PAPER), "\(APP)/icon.png")
write(square(512, MARK, fraction: 0.74, background: PAPER), "\(APP)/splash-icon.png")   // the sign-in tile
write(square(160, MARK, fraction: 0.74, background: PAPER), "\(APP)/logo.png")          // the header tile
write(square(48, MARK, fraction: 0.74, background: PAPER), "\(APP)/favicon.png")
// Android's adaptive icon is three layers it moves and masks independently.
let bg = bitmap(1024, 1024); bg.setFillColor(PAPER); bg.fill(CGRect(x: 0, y: 0, width: 1024, height: 1024))
write(bg.makeImage()!, "\(APP)/android-icon-background.png")
write(square(1024, MARK, fraction: 0.52, background: nil), "\(APP)/android-icon-foreground.png")
write(square(1024, MARK, fraction: 0.52, background: nil, tint: (255, 255, 255)), "\(APP)/android-icon-monochrome.png")

// ---- the splash --------------------------------------------------------------------------------

/// The splash is the whole lockup - bubble, تمتم and Tamtim - over the tagline. Light and dark are
/// the same artwork: in the dark one every green stroke becomes the cream, and the amber stays amber
/// (it reads well on both), which is how the owner's own file would be inverted by hand.
func splash(_ path: String, background: CGColor, dark: Bool, tagline: String) {
    let W = 1080, H = 900
    let ctx = bitmap(W, H)
    ctx.setFillColor(background); ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))

    let lockupW: CGFloat = 640
    let img = dark ? inkImageDark(LOCKUP, pxW: Int(lockupW * 3)) : inkImage(LOCKUP, pxW: Int(lockupW * 3))
    let lockupH = lockupW * LOCKUP.height / LOCKUP.width
    ctx.draw(img, in: CGRect(x: (CGFloat(W) - lockupW)/2, y: CGFloat(H) - 170 - lockupH, width: lockupW, height: lockupH))

    // The tagline in the app's own face, Tajawal, at the same weight the app uses for body text.
    let fontPath = "mobile/assets/fonts/Tajawal_400Regular.ttf"
    if let data = NSData(contentsOfFile: fontPath), let provider = CGDataProvider(data: data),
       let cg = CGFont(provider) {
        let font = CTFontCreateWithGraphicsFont(cg, 34, nil, nil)
        let colour = dark ? rgb(0x9A, 0xA8, 0xA1) : rgb(0x55, 0x61, 0x5B)
        let attrs: [NSAttributedString.Key: Any] = [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): colour,
        ]
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: tagline, attributes: attrs))
        let bounds = CTLineGetBoundsWithOptions(line, .useOpticalBounds)
        ctx.textPosition = CGPoint(x: (CGFloat(W) - bounds.width)/2, y: 215)
        CTLineDraw(line, ctx)
    } else {
        print("  (no Tajawal at \(fontPath): splash drawn without the tagline)")
    }
    write(ctx.makeImage()!, path)
}

/// The lockup with its green turned to cream, for the dark splash.
func inkImageDark(_ r: CGRect, pxW: Int) -> CGImage {
    let green = inkImage(r, pxW: pxW, tint: (242, 241, 235))     // everything cream
    let amber = inkImage(r, pxW: pxW)                            // the original, for the amber only
    let w = green.width, h = green.height
    let ctx = bitmap(w, h)
    ctx.draw(green, in: CGRect(x: 0, y: 0, width: w, height: h))
    // Paint the amber parts back in: they carry the same weight on dark as on light.
    let a = bitmap(w, h)
    a.draw(amber, in: CGRect(x: 0, y: 0, width: w, height: h))
    let bprA = a.bytesPerRow, pa = a.data!.bindMemory(to: UInt8.self, capacity: bprA*h)
    let bprG = ctx.bytesPerRow, pg = ctx.data!.bindMemory(to: UInt8.self, capacity: bprG*h)
    for y in 0..<h {
        for x in 0..<w {
            let oa = y*bprA + x*4, og = y*bprG + x*4
            let alpha = Double(pa[oa+3]) / 255
            guard alpha > 0.02 else { continue }
            let (r0, g0, b0) = (Double(pa[oa])/alpha, Double(pa[oa+1])/alpha, Double(pa[oa+2])/alpha)
            if r0 - b0 > 60 && r0 > g0 {                        // amber, not green
                pg[og] = pa[oa]; pg[og+1] = pa[oa+1]; pg[og+2] = pa[oa+2]; pg[og+3] = pa[oa+3]
            }
        }
    }
    return ctx.makeImage()!
}

print("splash:")
splash("\(APP)/splash-light.png", background: SPLASH_LIGHT, dark: false,
       tagline: "مراسلة عائلية بذاكرة لا تنسى")
splash("\(APP)/splash-dark.png", background: NIGHT, dark: true,
       tagline: "مراسلة عائلية بذاكرة لا تنسى")

// ---- things to look at, and the store's 1024 ----------------------------------------------------

print("brand/out:")
write(square(1024, MARK, fraction: 0.74, background: PAPER), "brand/out/icon-1024.png")   // App Store / Play
write(inkImage(LOCKUP, pxW: 1600), "brand/out/lockup.png")                                // transparent, for decks
write(square(512, MARK, fraction: 0.74, background: rgb(0x1F, 0x4D, 0x3F), invert: true),
      "brand/out/icon-512-on-green.png")                                                  // the inverse, to compare

// A sheet of the sizes an icon really lives at, light and dark, plus the circular mask.
let sheet = bitmap(900, 370)
sheet.setFillColor(PAPER); sheet.fill(CGRect(x: 0, y: 0, width: 900, height: 370))
let standard = square(512, MARK, fraction: 0.74, background: PAPER)
var x: CGFloat = 20
for size in [180, 120, 80, 48, 32] {
    sheet.draw(standard, in: CGRect(x: x, y: 370 - 20 - CGFloat(size), width: CGFloat(size), height: CGFloat(size)))
    x += CGFloat(size) + 16
}
let maskable = square(512, MARK, fraction: 0.56, background: PAPER)
sheet.saveGState()
sheet.addEllipse(in: CGRect(x: x + 20, y: 150, width: 200, height: 200)); sheet.clip()
sheet.draw(maskable, in: CGRect(x: x + 20, y: 150, width: 200, height: 200))
sheet.restoreGState()
sheet.setFillColor(NIGHT); sheet.fill(CGRect(x: 0, y: 0, width: 900, height: 130))
x = 20
for size in [80, 48, 32] {
    sheet.draw(standard, in: CGRect(x: x, y: 24, width: CGFloat(size), height: CGFloat(size)))
    x += CGFloat(size) + 16
}
write(sheet.makeImage()!, "brand/out/icon-preview.png")
print("done")
