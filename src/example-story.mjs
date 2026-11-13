// Pure shared copy: safe in Orca's isolated panel (no Node or filesystem imports).
export const EXAMPLE_STEPS = [
  { title: 'A bounded goal', speaker: 'You', text: 'Fix clamp() at its lower boundary and add a regression test.' },
  { title: 'Build', speaker: 'Builder', text: 'I reproduce the defect, make a small change, and run the tests.' },
  { title: 'Review', speaker: 'Reviewer', text: 'I inspect the diff and test coverage independently. I report findings instead of editing.' },
  { title: 'Fix and verify', speaker: 'Builder', text: 'I address review findings and rerun the tests.' },
  { title: 'Human acceptance', speaker: 'You', text: 'I inspect the result. Closing a view detaches it; stopping the team is a separate action.' }
]
