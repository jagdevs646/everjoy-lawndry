const { _android, request } = require('playwright-core');
const assert = require('node:assert/strict');

async function run() {
  const app = 'com.everjoy.lawndry';
  const [device] = await _android.devices({ omitDriverInstall: true });
  const backend = await request.newContext({ baseURL: 'http://127.0.0.1:3344/api/', extraHTTPHeaders: { 'x-ej': '1' } });
  try {
    const login = await backend.post('auth/login', { data: { loginId: 'ADMIN', password: 'Everjoy@123' } });
    assert.equal(login.status(), 200);
    const info = await (await backend.get('public/info')).json();
    const added = await backend.post('admin/students', { data: {
      idCardNo: 'WEBVIEW101', name: 'Emulator Student', email: 'emulator@uni.test', hostelId: info.hostels[0].id, roomNo: '42'
    }});
    assert.equal(added.status(), 201);
    const { codes } = await added.json();
    await device.shell('am start -n com.everjoy.lawndry/.MainActivity');
    const view = await device.webView({ pkg: app, timeout: 60000 });
    const page = await view.page();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.getByRole('link', { name: 'Have a claim code?' }).click();
    await page.getByLabel('ID card no. or university email').fill('WEBVIEW101');
    await page.getByPlaceholder('NZVE-6H4H').fill(codes[0].code);
    await page.getByRole('button', {name:'Register', exact:true}).click();
    await page.locator('input[type=password]').first().fill('device-test-password');
    await page.locator('input[type=password]').nth(1).fill('device-test-password');
    await page.getByRole('button', {name:'Save password'}).click();
    await page.getByLabel('Mobile number').fill('9876500101');
    await page.locator('input[type=file]').evaluate(input => {
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
      const photo = new File([bytes], 'avatar.png', {type:'image/png'});
      const dt = new DataTransfer();
      dt.items.add(photo);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', {bubbles:true}));
    });
    await page.getByRole('button', {name:'Continue'}).click();
    await page.locator('.st-home').waitFor();
    await page.reload();
    await page.locator('.st-home').waitFor();
    assert.deepEqual(errors, []);
    console.log('Android WebView completed the claim, saved the profile, opened home and restored the session on reload.');
  } finally {
    await backend.dispose();
    await device.close();
  }
}
run().catch(e => { console.error(e); process.exitCode=1; });
