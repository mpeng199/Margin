/**
 * End-to-end click-through in real Chrome against a fresh daemon on mock accounts.
 * The daemon starts at Mon Oct 26 2026 3:30 PM (playwright.config.ts); /api/dev/clock moves time
 * so one run covers the afternoon, the stop, Evening mode and the next morning.
 */
import { test, expect, type Page } from '@playwright/test';

const clock = (page: Page, iso: string) => page.request.post('/api/dev/clock', { data: { iso }, headers: { 'x-margin': '1' } });
const serverNow = async (page: Page) => Date.parse((await (await page.request.get('/api/dev/clock')).json()).now);
const cont = (page: Page) => page.getByRole('button', { name: /^(Continue|Finish)$/ }).click();

test('onboarding → daily loop → evening → morning → weekly review → project tab → second brain', async ({ page }) => {
  // ---------------- Onboarding (mock accounts)
  await page.goto('/');
  await expect(page).toHaveURL(/\/onboarding/);
  await expect(page.getByRole('heading', { name: 'Connect your accounts' })).toBeVisible();
  await cont(page);
  await expect(page.getByText(/hard stop 9:00 PM/)).toBeVisible();
  await cont(page);
  await page.getByRole('button', { name: 'Save and Check Capacity' }).click();
  await expect(page.getByText('What’s left before your stop')).toBeVisible();
  await page.getByRole('button', { name: 'Yes, Add Them' }).click();
  await expect(page.getByText(/weekly block|already on your calendar/)).toBeVisible();
  await cont(page);
  await cont(page); // off-day + review time defaults
  await page.getByRole('button', { name: 'Create Tabs' }).click();
  await expect(page.getByText('Created', { exact: true })).toBeVisible();
  await cont(page);
  await page.getByLabel(/Owner for Manuscript/).fill('Maya');
  await page.getByRole('button', { name: 'Save Owners' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await cont(page);
  await page.getByLabel('Application deadlines').fill('RSI application - 2027-01-14\nMIT PRIMES - 2026-12-01');
  await page.getByRole('button', { name: 'Import Deadlines' }).click();
  await expect(page.getByText(/Imported 2/)).toBeVisible();
  await cont(page);
  await page.getByRole('button', { name: 'Save Baseline' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await cont(page);

  // ---------------- Today is populated
  await expect(page).toHaveURL(/\/today/);
  await expect(page.getByText(/until your stop at 9:00 PM/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible();
  await expect(page.getByText(/Stabilize/).first()).toBeVisible();

  // Morning check-in widget (still unsubmitted today)
  await page.getByRole('button', { name: '6', exact: true }).first().click();
  await page.getByRole('button', { name: /Save Check-in/i }).click();
  await expect(page.getByText(/energy 6/)).toBeVisible();

  // ---------------- Plan within the caps
  await page.getByRole('button', { name: 'Plan the Day' }).first().click();
  await expect(page).toHaveURL(/\/plan/);
  const accept = page.getByRole('button', { name: 'Accept Plan' });
  // Over capacity → triage until it fits
  for (let i = 0; i < 6 && (await accept.isDisabled()); i++) {
    await page.getByRole('button', { name: 'Optional' }).first().click();
    await page.waitForTimeout(300);
  }
  await expect(accept).toBeEnabled();
  await page.getByRole('button', { name: 'Make Must-Do' }).first().click();
  await accept.click();
  await expect(page.getByText(/Accepted/)).toBeVisible();

  // ---------------- Focus block
  await page.goto('/focus');
  await page.getByRole('button', { name: /Start/ }).first().click();
  await expect(page.getByText(/Ends at/)).toBeVisible();
  await clock(page, new Date((await serverNow(page)) + 51 * 60_000).toISOString());
  await page.reload();
  await expect(page.getByText('Break', { exact: true })).toBeVisible();

  // ---------------- The stop: Evening mode, then the shutdown ritual
  await clock(page, '2026-10-26T21:05:00-04:00');
  await page.goto('/today');
  await expect(page.getByRole('button', { name: /I’m breaking my stop/ })).toBeVisible();
  await expect(page.getByText(/until lights-out/)).toBeVisible();
  await page.getByRole('button', { name: /Start Shutdown/ }).click();
  await expect(page).toHaveURL(/\/shutdown/);
  await page.getByLabel('Open loops, one per line').fill('Ask Dr. Lim about the poster template');
  for (let step = 0; step < 8; step++) {
    if (await page.getByRole('button', { name: 'Shutdown Complete' }).isVisible()) break;
    for (const b of await page.getByRole('button', { name: 'Covered' }).all()) await b.click();
    for (const f of await page.getByLabel(/^Next action for /).all()) if (!(await f.inputValue())) await f.fill('Open the doc and write one sentence');
    const phone = page.getByRole('button', { name: 'Confirm Phone Is Going Out' });
    if (await phone.isVisible()) await phone.click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForTimeout(250);
  }
  await page.getByRole('button', { name: 'Shutdown Complete' }).click();

  // Evening mode: capture lands in tomorrow's inbox
  await expect(page.getByText(/until lights-out/)).toBeVisible();
  await page.getByLabel('Capture for tomorrow').fill('Buy poster board');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(/tomorrow/i).first()).toBeVisible();
  // Work views are gated
  await page.goto('/calendar');
  await expect(page.getByRole('button', { name: /I’m breaking my stop/ })).toBeVisible();

  // ---------------- Next morning
  await clock(page, '2026-10-27T07:05:00-04:00');
  await page.goto('/today');
  await expect(page.getByText('Morning check-in')).toBeVisible();
  await expect(page.getByText('Buy poster board')).toBeVisible(); // From last night

  // ---------------- Weekly review (Sunday Nov 1, the 25-hour day)
  await clock(page, '2026-11-01T15:30:00-05:00');
  await page.goto('/review');
  await expect(page.getByText(/Step 1 of/)).toBeVisible();
  for (const s of await page.getByRole('slider').all()) { await s.focus(); await page.keyboard.press('ArrowRight'); }
  for (let step = 0; step < 10; step++) {
    const finish = page.getByRole('button', { name: 'Finish Review' });
    if (await finish.isVisible() && await finish.isEnabled()) { await finish.click(); break; }
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForTimeout(250);
  }
  await expect(page).toHaveURL(/\/(changes|today|review)/);

  // ---------------- A project tab with its own timeline
  await page.goto('/today');
  await page.getByRole('link', { name: /Delphic Medicine/ }).first().click();
  await expect(page).toHaveURL(/\/projects\//);
  await page.getByRole('button', { name: 'Timeline' }).click();
  await expect(page.getByText(/Today|today/).first()).toBeVisible();

  // ---------------- Second brain: compiled from onboarding, then a note of your own with a link
  await clock(page, '2026-11-02T10:00:00-05:00');
  await page.request.post('/api/brain/compile', { headers: { 'x-margin': '1' } });
  await page.goto('/brain');
  const list = page.getByRole('complementary', { name: 'Notes' });
  await expect(list.getByText('About me', { exact: true })).toBeVisible();
  await expect(list.getByText('Delphic Medicine', { exact: true })).toBeVisible();
  await expect(list.getByText('Maya', { exact: true })).toBeVisible(); // the owner named in onboarding
  await page.getByRole('button', { name: 'New Note' }).first().click();
  const title = page.getByRole('textbox', { name: 'Title', exact: true });
  await title.fill('Poster plan');
  await title.press('Enter');
  const editor = page.getByLabel('Note text, in Markdown');
  await editor.click();
  await editor.pressSequentially('Ask [[May');
  await expect(page.getByRole('option', { name: /Maya/ })).toBeVisible();
  await editor.press('Enter');
  await editor.pressSequentially(' about the poster. #lab');
  await expect(editor).toHaveValue('Ask [[Maya]] about the poster. #lab');
  await page.getByRole('button', { name: /^Done/ }).click();
  await page.getByRole('article').getByRole('link', { name: 'Maya' }).click();
  await expect(page.getByRole('heading', { name: 'Linked from' })).toBeVisible();
  await expect(page.getByRole('article').getByText('Poster plan', { exact: true })).toBeVisible();
  // ⌘K finds notes; ⌘N saves a thought as a note
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('poster plan');
  await expect(page.getByRole('option', { name: /Poster plan/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+n');
  await page.getByPlaceholder(/Email Dr. Lim/).fill('Bring the poster tube');
  await page.getByPlaceholder(/Email Dr. Lim/).press('ControlOrMeta+Enter');
  await expect(page.getByText(/Saved “Bring the poster tube” to your Notes inbox/)).toBeVisible();
});
