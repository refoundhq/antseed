from PIL import Image, ImageDraw, ImageFilter, ImageFont
from pathlib import Path
import math

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'apps/website/static/social'
OUT.mkdir(parents=True, exist_ok=True)

SOIL0 = (7, 11, 9)
SOIL1 = (10, 14, 20)
SOIL2 = (14, 20, 28)
GREEN = (31, 216, 122)
MINT = (151, 255, 199)
CLAY = (232, 163, 61)
TEXT = (237, 246, 238)
TEXT2 = (151, 170, 159)


def find_font(names, size):
    search = [
        '/System/Library/Fonts/Supplemental',
        '/System/Library/Fonts',
        '/Library/Fonts',
        str(Path.home() / 'Library/Fonts'),
    ]
    for base in search:
        b = Path(base)
        if not b.exists():
            continue
        for name in names:
            for p in b.rglob(name):
                try:
                    return ImageFont.truetype(str(p), size=size)
                except Exception:
                    pass
    return ImageFont.load_default()

DISPLAY = find_font(['Oxanium*.ttf', 'Oxanium*.otf', 'Arial Unicode.ttf', 'Arial.ttf'], 1)
MONO = find_font(['ShareTechMono*.ttf', 'Share Tech Mono*.ttf', 'Menlo.ttc', 'Courier New.ttf'], 1)

def font(size, mono=False):
    if mono:
        return find_font(['ShareTechMono*.ttf', 'Share Tech Mono*.ttf', 'Menlo.ttc', 'Courier New.ttf'], size)
    return find_font(['Oxanium*.ttf', 'Oxanium*.otf', 'Arial Unicode.ttf', 'Arial.ttf'], size)


def radial_bg(w, h):
    img = Image.new('RGBA', (w, h), SOIL0 + (255,))
    pix = img.load()
    for y in range(h):
        for x in range(w):
            # vertical soil gradient
            t = y / max(1, h-1)
            base = tuple(int(SOIL0[i]*(1-t) + SOIL1[i]*t) for i in range(3))
            # green glow top-left-ish
            dx, dy = (x - 0.18*w) / w, (y - 0.05*h) / h
            g = max(0, 1 - math.sqrt(dx*dx + dy*dy) / 0.42) ** 2
            # clay glow right edge, subtle
            dx2, dy2 = (x - 0.92*w) / w, (y - 0.18*h) / h
            c = max(0, 1 - math.sqrt(dx2*dx2 + dy2*dy2) / 0.36) ** 2
            r = int(base[0] + GREEN[0]*0.18*g + CLAY[0]*0.10*c)
            gg = int(base[1] + GREEN[1]*0.18*g + CLAY[1]*0.10*c)
            b = int(base[2] + GREEN[2]*0.18*g + CLAY[2]*0.10*c)
            pix[x, y] = (min(255, r), min(255, gg), min(255, b), 255)
    return img


def add_grid(img, step, alpha=24):
    d = ImageDraw.Draw(img, 'RGBA')
    w, h = img.size
    for x in range(0, w, step):
        d.line((x, 0, x, h), fill=MINT + (alpha//2,), width=1)
    for y in range(0, h, step):
        d.line((0, y, w, y), fill=MINT + (alpha,), width=1)


def glow_ellipse(layer, box, color, alpha, blur):
    g = Image.new('RGBA', layer.size, (0,0,0,0))
    gd = ImageDraw.Draw(g, 'RGBA')
    gd.ellipse(box, fill=color + (alpha,))
    g = g.filter(ImageFilter.GaussianBlur(blur))
    layer.alpha_composite(g)


def draw_ant(draw, cx, cy, scale, color=GREEN, alpha=255, stroke_scale=1.0):
    c = color + (alpha,)
    sc = scale
    # strokes / legs
    sw = max(2, int(2.8 * sc * stroke_scale))
    def line(p1, p2, a=180):
        draw.line((cx+p1[0]*sc, cy+p1[1]*sc, cx+p2[0]*sc, cy+p2[1]*sc), fill=color + (a,), width=sw)
    def dot(x,y,r,a=255):
        draw.ellipse((cx+(x-r)*sc, cy+(y-r)*sc, cx+(x+r)*sc, cy+(y+r)*sc), fill=color+(a,))
    line((-3,-23), (-14,-38), 210); line((3,-23), (14,-38), 210)
    dot(-14,-38,2.9,255); dot(14,-38,2.9,255)
    line((-7,-6), (-28,-18), 190); line((7,-6), (28,-18), 190)
    dot(-28,-18,2.9,255); dot(28,-18,2.9,255)
    line((-8,8), (-33,11), 190); line((8,8), (33,11), 190)
    dot(-33,11,2.9,255); dot(33,11,2.9,255)
    line((-7,27), (-30,39), 190); line((7,27), (30,39), 190)
    dot(-30,39,2.9,255); dot(30,39,2.9,255)
    # body
    draw.ellipse((cx-8*sc, cy-31*sc, cx+8*sc, cy-14*sc), fill=c)
    draw.ellipse((cx-11*sc, cy-12*sc, cx+11*sc, cy+12*sc), fill=c)
    draw.ellipse((cx-15*sc, cy+10*sc, cx+15*sc, cy+48*sc), fill=c)


def rounded_mask(size, radius):
    m = Image.new('L', size, 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle((0,0,size[0]-1,size[1]-1), radius=radius, fill=255)
    return m

# ---------------- Avatar PNG ----------------
S = 1200
avatar = radial_bg(S, S)
add_grid(avatar, 72, 22)
# vignette
v = Image.new('RGBA', (S,S), (0,0,0,0))
vd = ImageDraw.Draw(v, 'RGBA')
vd.ellipse((-120,-120,S+120,S+120), outline=(0,0,0,0), width=1)
# center glows
for box, a, blur in [((130,130,1070,1070), 70, 70), ((280,260,920,930), 95, 50), ((430,430,770,770), 95, 25)]:
    glow_ellipse(avatar, box, GREEN, a, blur)
# ring safe for circular crop
ad = ImageDraw.Draw(avatar, 'RGBA')
ad.ellipse((122,122,1078,1078), outline=MINT+(38,), width=4)
ad.ellipse((195,195,1005,1005), outline=GREEN+(55,), width=3)
# dotted rail behind mark
for i in range(20):
    x = 180 + i*44
    y = 610 + int(math.sin(i*.8)*28)
    ad.ellipse((x-5,y-5,x+5,y+5), fill=MINT+(75,))
# ant with glow
mark_layer = Image.new('RGBA', (S,S), (0,0,0,0))
md = ImageDraw.Draw(mark_layer, 'RGBA')
draw_ant(md, S//2, S//2-8, 7.7, GREEN, 255, 1.0)
shadow = mark_layer.filter(ImageFilter.GaussianBlur(20))
shadow2 = mark_layer.filter(ImageFilter.GaussianBlur(54))
# tint shadows already green due alpha; compose below
tmp = Image.new('RGBA',(S,S),(0,0,0,0)); tmp.alpha_composite(shadow2); tmp.alpha_composite(shadow); tmp.alpha_composite(mark_layer)
avatar.alpha_composite(tmp)
# subtle corner clay seed, very small economics hint but not dominant
ad.ellipse((908,870,936,898), fill=CLAY+(210,))
glow_ellipse(avatar, (860,822,984,946), CLAY, 58, 24)
# rounded square export (X crops to circle but square looks polished)
avatar.putalpha(rounded_mask((S,S), 128))
avatar.save(OUT / 'x-avatar-antseed.png')

# ---------------- Banner PNG ----------------
W,H = 1500,500
banner = radial_bg(W,H)
add_grid(banner, 50, 18)
bd = ImageDraw.Draw(banner, 'RGBA')
# safe central band for X cropping on mobile
bd.rounded_rectangle((76,72,1424,428), radius=34, outline=MINT+(34,), width=1, fill=(255,255,255,6))
# rails
for row, y in enumerate([150, 250, 350]):
    for x in range(90, 1410, 28):
        if (x//28 + row) % 3 != 0:
            bd.ellipse((x-2,y-2,x+2,y+2), fill=MINT+(38,))
# ant constellation left
for pos, sc, a in [((205,250),3.3,255), ((86,132),1.35,90), ((330,374),1.15,80), ((1310,120),1.1,65), ((1226,375),1.4,70)]:
    layer = Image.new('RGBA',(W,H),(0,0,0,0)); ld=ImageDraw.Draw(layer,'RGBA')
    draw_ant(ld, pos[0], pos[1], sc, GREEN, a, 0.8)
    banner.alpha_composite(layer.filter(ImageFilter.GaussianBlur(10 if sc>2 else 5)))
    banner.alpha_composite(layer)
# typography
try:
    title_font = font(106)
    mono_font = font(23, mono=True)
    small_font = font(17, mono=True)
except Exception:
    title_font = ImageFont.load_default(); mono_font=title_font; small_font=title_font
x0 = 420
bd.text((x0,138), 'ANT', font=title_font, fill=TEXT+(255,))
# text width
try:
    ant_w = bd.textbbox((x0,138),'ANT',font=title_font)[2]-x0
except Exception:
    ant_w = 190
bd.text((x0+ant_w+8,138), 'SEED', font=title_font, fill=GREEN+(255,))
bd.text((x0+3,270), 'THE OPEN MARKET FOR AI INFERENCE', font=mono_font, fill=MINT+(230,))
# bottom line
bd.line((x0+3,333, x0+615,333), fill=GREEN+(125,), width=2)
for i, txt in enumerate(['P2P', 'PRIVATE', 'USDC', 'NO GATEKEEPERS']):
    fill = CLAY+(235,) if txt == 'USDC' else TEXT2+(235,)
    xx = x0 + 3 + i*150
    bd.rounded_rectangle((xx,358,xx+128,392), radius=17, outline=(CLAY+(85,) if txt=='USDC' else MINT+(45,)), fill=(CLAY+(22,) if txt=='USDC' else GREEN+(13,)))
    bd.text((xx+18,365), txt, font=small_font, fill=fill)
# clay small orbit/seed on far right economics accent
for r,a in [(96,24),(52,44),(17,210)]:
    if r == 17:
        bd.ellipse((1298-r,250-r,1298+r,250+r), fill=CLAY+(a,))
    else:
        bd.ellipse((1298-r,250-r,1298+r,250+r), outline=CLAY+(a,), width=2)
banner.save(OUT / 'x-banner-antseed.png')
