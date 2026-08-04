from PIL import Image, ImageDraw, ImageFont

W, H = 2500, 1686

BG = (15, 18, 22)
ACCENT = (255, 122, 26)
FG = (238, 242, 246)
MUTED = (154, 167, 180)

img = Image.new('RGB', (W, H), BG)
draw = ImageDraw.Draw(img)

# レイアウト境界: ボール領域は左側、テキスト領域は右側で明確に分離
ball_zone_cx = int(W * 0.225)
text_left = int(W * 0.46)
text_right = int(W * 0.96)

# 左側: バスケットボール絵文字
emoji_font = ImageFont.truetype("C:/Windows/Fonts/seguiemj.ttf", int(H * 0.52))
emoji = "\U0001F3C0"
bbox = draw.textbbox((0, 0), emoji, font=emoji_font, embedded_color=True)
ew, eh = bbox[2] - bbox[0], bbox[3] - bbox[1]
ex = ball_zone_cx - ew / 2 - bbox[0]
ey = H / 2 - eh / 2 - bbox[1]
draw.text((ex, ey), emoji, font=emoji_font, embedded_color=True)

# 右側: タイトル・サブタイトル・ボタン(すべて左揃えでテキスト領域内に収める)
title_font = ImageFont.truetype("C:/Windows/Fonts/meiryob.ttc", int(H * 0.125))
sub_font = ImageFont.truetype("C:/Windows/Fonts/meiryo.ttc", int(H * 0.05))
btn_font = ImageFont.truetype("C:/Windows/Fonts/meiryob.ttc", int(H * 0.072))

title = "シュート記録"
draw.text((text_left, H * 0.30), title, font=title_font, fill=FG)

sub = "タップして記録を開く"
draw.text((text_left, H * 0.475), sub, font=sub_font, fill=MUTED)

# CTAボタン(テキスト領域の幅いっぱい)
btn_text = "アプリを開く  ▶"
bb = draw.textbbox((0, 0), btn_text, font=btn_font)
btn_w = text_right - text_left
btn_h = int(H * 0.155)
btn_x0 = text_left
btn_y0 = H * 0.62
btn_box = [btn_x0, btn_y0, btn_x0 + btn_w, btn_y0 + btn_h]
draw.rounded_rectangle(btn_box, radius=int(btn_h * 0.3), fill=ACCENT)
btn_cx = btn_x0 + btn_w / 2
draw.text((btn_cx - (bb[2]-bb[0])/2 - bb[0], btn_y0 + btn_h/2 - (bb[3]-bb[1])/2 - bb[1]), btn_text, font=btn_font, fill=(20, 14, 8))

img.save('assets/richmenu_2500x1686.png')
img.resize((1200, 810), Image.LANCZOS).save('assets/richmenu_1200x810.png')
img.resize((800, 540), Image.LANCZOS).save('assets/richmenu_800x540.png')
print('saved')
