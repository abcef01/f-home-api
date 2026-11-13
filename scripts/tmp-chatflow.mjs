const base = 'http://127.0.0.1:3000';
const login = await (await fetch(base + '/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ passphrase: 'test-1234' })
})).json();
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token };

const s = await (await fetch(base + '/api/chat', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ message: '这是测试消息，能看到吗', storeOnly: true })
})).json();

console.log('存下来的用户消息:', JSON.stringify(s.userMessage?.content));
console.log('storeOnly 返回:', JSON.stringify(s).slice(0, 160));

const r = await (await fetch(base + '/api/respond', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ conversationId: s.conversationId })
})).json();

console.log('他的回复:', JSON.stringify((r.replies || []).map((x) => x.content)));
