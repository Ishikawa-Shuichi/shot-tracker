from PIL import Image, ImageDraw, ImageFont

FINAL = 640
BG = (15, 18, 22)
EMOJI = "\U0001F3C0"  # 🏀 BASKETBALL AND HOOP (「記録」タブと同じ絵文字)

img = Image.new('RGB', (FINAL, FINAL), BG)
draw = ImageDraw.Draw(img)

font = ImageFont.truetype("C:/Windows/Fonts/seguiemj.ttf", int(FINAL * 0.72))
bbox = draw.textbbox((0, 0), EMOJI, font=font, embedded_color=True)
w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
pos = ((FINAL - w) / 2 - bbox[0], (FINAL - h) / 2 - bbox[1])
draw.text(pos, EMOJI, font=font, embedded_color=True)

img.save('assets/icon.png')
print('saved')
