const isSponsored = text => /\bsponsored\b|广告|赞助/i.test(text || '');
const validAsin = asin => /^B0[A-Z0-9]{8}$/.test(String(asin || '').toUpperCase());

function classifySearchCards(cards, brand, targetAsins = []) {
  let naturalCount = 0;
  let sponsoredCount = 0;
  const candidates = [];
  for (const original of cards || []) {
    const card = { ...original, asin: String(original.asin || '').toUpperCase() };
    if (!validAsin(card.asin)) continue;
    if (isSponsored(card.text)) { sponsoredCount += 1; continue; }
    naturalCount += 1;
    if (new RegExp(`\\b${String(brand || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(card.text || '') || targetAsins.includes(card.asin)) {
      candidates.push({ ...card, pageNaturalPosition: naturalCount });
    }
  }
  return { naturalCount, sponsoredCount, candidates };
}

module.exports = { isSponsored, validAsin, classifySearchCards };
