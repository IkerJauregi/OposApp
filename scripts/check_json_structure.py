from pathlib import Path

path = Path(__file__).resolve().parent.parent / 'data' / 'preguntas-rayos.json'
text = path.read_text(encoding='utf-8')
stack = []
line = 1
for i, ch in enumerate(text):
    if ch == '\n':
        line += 1
        continue
    if ch in '[{':
        stack.append((ch, i, line))
    elif ch == ']':
        if stack and stack[-1][0] == '[':
            stack.pop()
        else:
            print('UNMATCHED ] at', i, 'line', line)
            break
    elif ch == '}':
        if stack and stack[-1][0] == '{':
            stack.pop()
        else:
            print('UNMATCHED } at', i, 'line', line)
            break
else:
    print('stack len', len(stack))
    if stack:
        for item in stack[-10:]:
            print('unclosed', item)
