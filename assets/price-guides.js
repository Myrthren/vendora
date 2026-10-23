(() => {
  'use strict';
  const element = document.getElementById('guide-data');
  if (!element) return;
  const { weekly: card } = JSON.parse(element.textContent);
  const canvas = document.getElementById('weekly-card');
  if (!card || !canvas) return;
  const ctx = canvas.getContext('2d');
  const price = value => '£' + Number(value).toFixed(Number(value) % 1 ? 2 : 0);
  function text(value, x, y, maxWidth, lineHeight) {
    let line = '';
    for (const word of value.split(' ')) {
      const trial = line ? line + ' ' + word : word;
      if (ctx.measureText(trial).width > maxWidth && line) { ctx.fillText(line, x, y); line = word; y += lineHeight; }
      else line = trial;
    }
    if (line) ctx.fillText(line, x, y);
    return y;
  }
  ctx.fillStyle = '#0c0a0e'; ctx.fillRect(0, 0, 1080, 1350);
  const glow = ctx.createRadialGradient(920, 100, 10, 920, 100, 700);
  glow.addColorStop(0, '#6e193c'); glow.addColorStop(1, '#0c0a0e'); ctx.fillStyle = glow; ctx.fillRect(0, 0, 1080, 800);
  ctx.fillStyle = '#f35b9f'; ctx.fillRect(70, 65, 70, 6);
  ctx.font = 'bold 25px Arial'; ctx.fillStyle = '#d1b5c4'; ctx.fillText('VENDEX / THE WEEKLY PRICE CARD', 70, 125);
  ctx.font = 'bold 73px Arial'; ctx.fillStyle = '#ffffff';
  const y = text(card.keyword.replace(/\b\w/g, c => c.toUpperCase()), 70, 245, 940, 86);
  ctx.font = '25px Arial'; ctx.fillStyle = '#bcaab6'; ctx.fillText('VINTED UK · ' + card.from + ' — ' + card.to, 70, y + 65);
  ctx.font = 'bold 170px Arial'; ctx.fillStyle = '#ffffff'; ctx.fillText(price(card.median), 65, y + 285);
  ctx.font = '31px Arial'; ctx.fillStyle = '#d3c6cf'; ctx.fillText('Weekly median asking price', 75, y + 345);
  ctx.strokeStyle = '#59404e'; ctx.beginPath(); ctx.moveTo(70, 810); ctx.lineTo(1010, 810); ctx.stroke();
  ctx.font = 'bold 48px Arial'; ctx.fillStyle = '#ff83b8'; ctx.fillText(price(card.p25) + ' – ' + price(card.p75), 70, 900);
  ctx.font = '28px Arial'; ctx.fillStyle = '#d3c6cf'; ctx.fillText('Typical middle range · ' + card.observedDays + ' sampled days', 70, 958);
  ctx.font = '24px Arial'; ctx.fillStyle = '#bcaab6';
  text('Asking prices, not completed sales. Category samples can include different models, sizes and conditions. Repeated observations are possible.', 70, 1050, 920, 34);
  ctx.font = 'bold 30px Arial'; ctx.fillStyle = '#ffffff'; ctx.fillText('vendora.site/price-guides', 70, 1250);
  document.getElementById('download-card').addEventListener('click', () => {
    const status = document.getElementById('card-status');
    try { canvas.toBlob(blob => {
      if (!blob) { status.textContent = 'Could not generate the image. Please try again.'; return; }
      const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = `vendex-${card.slug}-week-${card.week}.png`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); status.textContent = 'Your weekly PNG is ready.';
    }, 'image/png'); } catch { status.textContent = 'Could not generate the image in this browser.'; }
  });
})();
