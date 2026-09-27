# index.htmlのインライン<script>を取り出して.jsに保存(node --checkで本物の構文解析をするため)
import re, sys
src = open(sys.argv[1], encoding='utf-8').read()
scripts = re.findall(r'<script(?![^>]*src=)[^>]*>(.*?)</script>', src, re.S)
open(sys.argv[2], 'w', encoding='utf-8').write('\n;\n'.join(scripts))
print('extracted %d script(s)' % len(scripts))
