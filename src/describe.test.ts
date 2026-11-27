import { assert, test } from 'orca/testing'
import { describeAhead, describeGit } from './describe'

test('los commits sin subir salen en su propia etiqueta, solo si hay alguno', () => {
  assert.deepEqual(describeAhead({ kind: 'up-to-date', upstream: 'origin/main', ahead: 1 }), {
    text: '1 unpushed commit',
    tone: 'warning',
    detail: 'They are only in your local branch: git push to share them.'
  })
  assert.equal(describeAhead({ kind: 'failed', step: 'merge', message: 'x', ahead: 3 })?.text, '3 unpushed commits')
  assert.equal(describeAhead({ kind: 'up-to-date', upstream: 'origin/main' }), null)
  assert.equal(describeAhead({ kind: 'dirty' }), null)
})

test('un avance con rebase lo dice, y un rebase que falla también', () => {
  const rebased = describeGit({ kind: 'updated', upstream: 'origin/main', count: 3, commits: [], rebased: 2 })
  assert.equal(rebased.text, '3 new commits')
  assert.equal(rebased.detail, 'Rebased 2 local commits on top of origin/main.')
  const failed = describeGit({ kind: 'failed', step: 'rebase', message: 'error: could not apply r9' })
  assert.equal(failed.text, 'Rebase failed')
  assert.equal(failed.tone, 'danger')
})
