import { assert, test } from 'orca/testing'
import { describeAhead, describeGit, describeGitNow } from './describe'

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

test('la etiqueta de la última ejecución sigue a la rama: aplicados a mano o con más commits', () => {
  const fetched = { kind: 'fetched' as const, upstream: 'origin/main', count: 7, commits: [] }
  assert.equal(describeGitNow(fetched, undefined).text, '7 commits not applied')
  assert.equal(describeGitNow(fetched, 7).text, '7 commits not applied')
  assert.equal(describeGitNow(fetched, 9).text, '9 commits not applied')
  assert.deepEqual(describeGitNow(fetched, 0), {
    text: 'Up to date now',
    tone: 'success',
    detail: 'The 7 commits this run left unapplied are in your branch now.'
  })
  assert.equal(describeGitNow({ kind: 'up-to-date', upstream: 'origin/main' }, 0).text, 'Up to date')
})
