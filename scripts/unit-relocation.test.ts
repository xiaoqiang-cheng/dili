import assert from 'node:assert/strict';
import test from 'node:test';
import { planUnitRelocation, unitCheckout } from './unit-relocation.ts';

const unit = (options: { working: string; exec: string; environment?: string[] }) => [
  '# Managed by Dili.',
  '[Unit]',
  'Description=Dili personal agent workbench',
  '',
  '[Service]',
  'Type=simple',
  `WorkingDirectory=${options.working}`,
  ...(options.environment ?? []),
  `ExecStart=${options.exec}`,
  'Restart=on-failure',
  '',
  '[Install]',
  'WantedBy=default.target',
  '',
].join('\n');

test('finds the checkout in both ExecStart shapes', () => {
  assert.equal(unitCheckout('/home/me/Develop/dili/start.sh'), '/home/me/Develop/dili');
  assert.equal(unitCheckout('"/usr/bin/node" "/home/me/Develop/dili/bin/dili.mjs"'), '/home/me/Develop/dili');
  assert.equal(unitCheckout('"/usr/bin/other" --serve'), null);
});

test('rewrites the old checkout in place and keeps custom environment lines', () => {
  const text = unit({
    working: '/home/me/Develop/sessiondeck',
    environment: [
      'Environment="CODEX_HOME=/home/me/.codex"',
      'Environment="SESSIONDECK_DATA_DIR=/home/me/Develop/sessiondeck/.sessiondeck"',
    ],
    exec: '"/usr/bin/node" "/home/me/Develop/sessiondeck/bin/dili.mjs"',
  });
  const plan = planUnitRelocation(text, '/home/me/Develop/dili');
  assert.equal(plan.action, 'rewrite');
  assert.equal(plan.from, '/home/me/Develop/sessiondeck');
  assert.match(plan.text ?? '', /^WorkingDirectory=\/home\/me\/Develop\/dili$/mu);
  assert.match(plan.text ?? '', /ExecStart="\/usr\/bin\/node" "\/home\/me\/Develop\/dili\/bin\/dili\.mjs"/u);
  assert.match(plan.text ?? '', /^Environment="CODEX_HOME=\/home\/me\/\.codex"$/mu);
  assert.match(plan.text ?? '', /^Environment="SESSIONDECK_DATA_DIR=\/home\/me\/Develop\/dili\/\.sessiondeck"$/mu);
});

test('leaves a sibling directory that shares the prefix alone', () => {
  const text = unit({
    working: '/home/me/Develop/sessiondeck',
    environment: ['Environment="CODEX_HOME=/home/me/Develop/sessiondeck-old/data"'],
    exec: '/home/me/Develop/sessiondeck/start.sh',
  });
  const plan = planUnitRelocation(text, '/home/me/Develop/dili');
  assert.equal(plan.action, 'rewrite');
  assert.match(plan.text ?? '', /^Environment="CODEX_HOME=\/home\/me\/Develop\/sessiondeck-old\/data"$/mu);
});

test('does nothing when the unit already names this checkout', () => {
  const text = unit({ working: '/home/me/Develop/dili', exec: '/home/me/Develop/dili/start.sh' });
  assert.deepEqual(planUnitRelocation(text, '/home/me/Develop/dili'), { action: 'none' });
});

test('asks for a reinstall when the unit is not ours', () => {
  const text = unit({ working: '/srv/other', exec: '"/usr/bin/other" --serve' });
  assert.equal(planUnitRelocation(text, '/home/me/Develop/dili').action, 'reinstall');
});

test('asks for a reinstall instead of guessing escaped paths', () => {
  const text = unit({ working: '/home/me/Develop/sessiondeck', exec: '/home/me/Develop/sessiondeck/start.sh' });
  assert.equal(planUnitRelocation(text, '/home/me/Develop/di%li').action, 'reinstall');
  assert.equal(planUnitRelocation(unit({ working: '/home/me/a%$b', exec: '/home/me/a%$b/start.sh' }), '/home/me/Develop/dili').action, 'reinstall');
});
