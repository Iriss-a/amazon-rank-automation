// One authoritative product decision.  It deliberately accepts family evidence
// only when Amazon variation metadata contains BOTH current and target ASINs.
const asin = value => (String(value || '').toUpperCase().match(/\bB0[A-Z0-9]{8}\b/) || [null])[0];
const unique = values => [...new Set((values || []).map(asin).filter(Boolean))];

function productMatch({ actualAsin, targetAsins, variationEvidence = null }) {
  const actual = asin(actualAsin);
  const targets = unique(targetAsins);
  if (!actual) return { status: 'FAILED', reason: 'ACTUAL_ASIN_UNAVAILABLE' };
  if (!targets.length) return { status: 'FAILED', reason: 'TARGET_ASIN_SET_EMPTY' };
  if (targets.includes(actual)) return { status: 'FOUND', matchType: 'EXACT_ASIN', actualAsin: actual, matchedTargetAsin: actual };

  const evidence = variationEvidence || {};
  const parentAsins = unique(evidence.parentAsins);
  const members = unique(evidence.familyAsins);
  const actualInFamily = members.includes(actual);
  const sibling = targets.find(target => members.includes(target));
  if (parentAsins.length && actualInFamily && sibling && evidence.hasDimensionMap === true) {
    return { status: 'FOUND', matchType: 'VARIATION_FAMILY', actualAsin: actual, matchedTargetAsin: sibling, parentAsins };
  }
  return { status: 'NOT_FOUND', reason: 'NO_EXACT_OR_PROVEN_VARIATION_FAMILY', actualAsin: actual, evidence: { parentAsins, actualInFamily, targetFamilyMembers: targets.filter(target => members.includes(target)), hasDimensionMap: evidence.hasDimensionMap === true } };
}

async function collectVariationEvidence(page, actualAsin, targetAsins) {
  return page.evaluate(({ actual, targets }) => {
    const upperAsin = value => (String(value || '').toUpperCase().match(/\bB0[A-Z0-9]{8}\b/) || [null])[0];
    const parentAsins = new Set();
    const familyAsins = new Set();
    let hasDimensionMap = false;
    for (const script of document.scripts) {
      const text = script.textContent || '';
      const upper = text.toUpperCase();
      if (!upper.includes(actual)) continue;
      const mapLike = /dimensionToAsinMap|asinVariationValues|variationValues|twister/i.test(text);
      if (!mapLike) continue;
      const relatedTarget = targets.some(target => upper.includes(target));
      if (!relatedTarget) continue;
      hasDimensionMap = true;
      for (const value of upper.match(/\bB0[A-Z0-9]{8}\b/g) || []) familyAsins.add(value);
      for (const match of text.matchAll(/(?:parentAsin|parent_asin)[^B]{0,100}(B0[A-Z0-9]{8})/gi)) parentAsins.add(match[1].toUpperCase());
    }
    return { parentAsins: [...parentAsins], familyAsins: [...familyAsins], hasDimensionMap };
  }, { actual: asin(actualAsin), targets: unique(targetAsins) });
}

module.exports = { productMatch, collectVariationEvidence, normalizeAsin: asin };
