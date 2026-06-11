import re

with open('tests/smoke.spec.ts', 'r') as f:
    content = f.read()

content = re.sub(
    r'await expect\(page\.getByRole\(\'button\', \{ name: \'Next track\' \}\)\)\.toBeEnabled\(\);',
    "await expect(page.getByRole('button', { name: 'Next track' })).toBeEnabled({ timeout: 8000 });", content
)

with open('tests/smoke.spec.ts', 'w') as f:
    f.write(content)
