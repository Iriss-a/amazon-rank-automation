const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function formatBusinessDate(epoch) {
  const date = new Date(epoch);
  return `${date.getUTCFullYear()}/${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}

function formatDateLike(epoch, sample) {
  const date = new Date(epoch);
  const text = clean(sample);
  const padLike = (value, token) => String(value).padStart(token.length, '0');
  let match = text.match(/^(\d{4})([\/-])(\d{1,2})\2(\d{1,2})$/);
  if (match) return `${date.getUTCFullYear()}${match[2]}${padLike(date.getUTCMonth() + 1, match[3])}${match[2]}${padLike(date.getUTCDate(), match[4])}`;
  match = text.match(/^(\d{1,2})([\/-])(\d{1,2})\2(\d{2}|\d{4})$/);
  if (match) {
    const year = match[4].length === 2 ? String(date.getUTCFullYear()).slice(-2) : String(date.getUTCFullYear());
    return `${padLike(date.getUTCMonth() + 1, match[1])}${match[2]}${padLike(date.getUTCDate(), match[3])}${match[2]}${year}`;
  }
  return formatBusinessDate(epoch);
}

module.exports = { formatBusinessDate, formatDateLike };
