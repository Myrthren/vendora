(() => {
  'use strict';
  const launcher = document.getElementById('mi-toggle');
  const panel = document.getElementById('mi-panel');
  if (!launcher || !panel) return;
  const byId = id => document.getElementById(id);
  const history = [];
  let caps = null, busy = false, loaded = false, configLoading = null;
  async function request(path, options = {}) {
    const { data: { session } } = await window._sb.auth.getSession();
    if (!session) throw new Error('Your session expired. Sign in again to use member support.');
    const response = await fetch(window._BOT_API + path, { ...options, signal: AbortSignal.timeout(45000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not reach member support. Please try again.');
    return data;
  }
  function addMessage(role, text, error = false) {
    const bubble = document.createElement('div'); bubble.className = `mi-message ${role}${error ? ' error' : ''}`;
    bubble.textContent = text; byId('mi-messages').append(bubble); bubble.scrollIntoView({ block: 'nearest' });
  }
  async function loadConfig() {
    if (configLoading) return configLoading;
    configLoading = (async () => {
      byId('mi-plan').textContent = 'Checking your current plan…';
      try {
        const data = await request('/api/member-intelligence'); caps = data.capabilities; loaded = true;
        byId('mi-plan').textContent = `${caps.tier === 'none' ? 'Account support' : caps.tier[0].toUpperCase() + caps.tier.slice(1) + ' member support'} · ${caps.dailyQuestions} questions per day`;
        byId('mi-scope').textContent = caps.repriceCoach ? 'Account support, tool guidance, synced inventory and the repricing coach.' : caps.inventoryGuidance ? 'Account support, tool guidance and your synced inventory.' : caps.toolGuidance ? 'Account support, setup and guidance for your plan’s tools.' : 'Help with account access, billing and restoring your subscription.';
        byId('mi-reminders').checked = data.remindersEnabled; byId('mi-reminders').disabled = false;
        byId('mi-coach-tools').hidden = !caps.repriceCoach; byId('mi-coach-locked').hidden = caps.repriceCoach;
        byId('mi-chips').replaceChildren();
        const questions = ['Help me get started', 'My Vinted connection is not working', 'Help with my subscription'];
        if (caps.inventoryGuidance) questions.push('Help me understand my synced inventory');
        if (caps.repriceCoach) questions.push('Explain my repricing suggestions');
        questions.forEach(question => { const button = document.createElement('button'); button.type = 'button'; button.className = 'mi-chip'; button.textContent = question; button.addEventListener('click', () => ask(question)); byId('mi-chips').append(button); });
      } catch (e) { loaded = false; caps = null; byId('mi-plan').textContent = e.message; byId('mi-scope').textContent = 'We couldn’t check your plan. You can still contact support.'; }
    })().finally(() => { configLoading = null; });
    return configLoading;
  }
  async function open() {
    panel.hidden = false; launcher.setAttribute('aria-expanded', 'true'); byId('mi-input').focus();
    await loadConfig();
  }
  function close() { panel.hidden = true; launcher.setAttribute('aria-expanded', 'false'); launcher.focus(); }
  window.openMemberIntelligence = open;
  launcher.addEventListener('click', () => panel.hidden ? open() : close());
  byId('mi-close').addEventListener('click', close);
  document.querySelectorAll('[data-open-intelligence]').forEach(button => button.addEventListener('click', open));
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) { event.stopPropagation(); close(); } });
  async function ask(question) {
    const text = question.trim().slice(0, 1000); if (!text || busy) return;
    if (!loaded) await loadConfig();
    if (!loaded) { addMessage('assistant', 'Please try opening support again, or use Contact support below.', true); return; }
    busy = true; byId('mi-send').disabled = true; byId('mi-send').textContent = '…'; byId('mi-input').value = '';
    addMessage('user', text);
    const messages = [...history, { role: 'user', content: text }].slice(-6);
    const pending = document.createElement('div'); pending.className = 'mi-state'; pending.textContent = 'Thinking…'; byId('mi-messages').append(pending);
    try {
      const data = await request('/api/member-intelligence', { method: 'POST', body: JSON.stringify({ messages }) });
      history.push({ role: 'user', content: text }, { role: 'assistant', content: data.response });
      if (history.length > 20) history.splice(0, history.length - 20);
      addMessage('assistant', data.response); caps = data.capabilities;
    } catch (error) { addMessage('assistant', error.name === 'TimeoutError' ? 'This is taking longer than expected. Please try again or contact support.' : error.message, true); }
    finally { pending.remove(); busy = false; byId('mi-send').disabled = false; byId('mi-send').textContent = 'Ask'; if (!panel.hidden) byId('mi-input').focus(); }
  }
  byId('mi-form').addEventListener('submit', event => { event.preventDefault(); ask(byId('mi-input').value); });
  function selectTab(tab) {
    const coach = tab.dataset.miTab === 'coach';
    document.querySelectorAll('[data-mi-tab]').forEach(button => button.setAttribute('aria-selected', String(button === tab)));
    byId('mi-chat-tab').tabIndex = coach ? -1 : 0; byId('mi-coach-tab').tabIndex = coach ? 0 : -1;
    byId('mi-chat').hidden = coach; byId('mi-coach').hidden = !coach;
    if (coach && caps?.repriceCoach) loadCoach();
  }
  document.querySelectorAll('[data-mi-tab]').forEach(tab => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const target = event.key === 'Home' ? byId('mi-chat-tab') : event.key === 'End' ? byId('mi-coach-tab') : byId(tab.dataset.miTab === 'chat' ? 'mi-coach-tab' : 'mi-chat-tab'); target.focus(); selectTab(target); } });
  });
  function contactSupport() {
    close(); window.showSection('support', document.querySelector('.nav-item[onclick*="support"]'));
    const field = byId('support-message');
    if (!field.value.trim() && history.length) {
      byId('support-subject').value = 'Other';
      field.value = 'Please help with this issue.\n\nMember support conversation (review before sending):\n' + history.slice(-4).map(m => `${m.role === 'user' ? 'Me' : 'Vendora Intel'}: ${m.content}`).join('\n\n').slice(0, 1400);
    }
    field.focus(); field.scrollIntoView({ block: 'center' });
  }
  byId('mi-contact').addEventListener('click', contactSupport);
  byId('mi-view-plans').addEventListener('click', () => { close(); window.showSection('subscription', document.querySelector('.nav-item[onclick*="subscription"]')); });
  const price = n => '£' + Number(n).toFixed(Number(n) % 1 ? 2 : 0);
  let reviewing = false;
  async function loadCoach() {
    if (reviewing) return; reviewing = true; byId('mi-coach-refresh').disabled = true;
    byId('mi-coach-results').replaceChildren(); byId('mi-coach-state').textContent = 'Reviewing your synced listings…';
    try {
      const data = await request('/api/reprice-coach');
      byId('mi-coach-state').textContent = data.reason || `${data.items.length} listing${data.items.length === 1 ? '' : 's'} to review. Inventory synced ${new Date(data.lastSynced).toLocaleString('en-GB')}.`;
      data.items.forEach(item => {
        const card = document.createElement('article'); card.className = 'mi-review';
        const title = document.createElement('h4'); title.textContent = item.title;
        const prices = document.createElement('div'); prices.className = 'mi-prices';
        const current = document.createElement('del'); current.textContent = price(item.currentPrice);
        const suggestion = document.createElement('strong'); suggestion.textContent = 'Consider ' + price(item.suggestedPrice); prices.append(current, suggestion);
        const copy = document.createElement('p'); copy.textContent = item.explanation;
        const source = document.createElement('p'); source.className = 'mi-note'; source.textContent = `Reference date ${item.evidenceDay} · ${item.observations} observations (may repeat listings). ${item.costKnown ? 'Check your full costs before changing the price.' : 'Purchase cost is not recorded; check your margin first.'}`;
        card.append(title, prices, copy, source);
        if (item.url && /^https:\/\/www\.vinted\.co\.uk\/items\/\d+$/.test(item.url)) { const link = document.createElement('a'); link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Review listing on Vinted ↗'; card.append(link); }
        byId('mi-coach-results').append(card);
      });
    } catch (e) { byId('mi-coach-state').textContent = e.message; }
    finally { reviewing = false; byId('mi-coach-refresh').disabled = false; }
  }
  byId('mi-coach-refresh').addEventListener('click', loadCoach);
  byId('mi-reminders').addEventListener('change', async event => {
    const control = event.target; const enabled = control.checked; control.disabled = true;
    try { const data = await request('/api/reprice-coach/preferences', { method: 'PATCH', body: JSON.stringify({ enabled }) }); control.checked = data.remindersEnabled; byId('mi-reminder-status').textContent = enabled ? 'Discord reminders are on. We only send when a listing has a useful suggestion, at most once per listing each week.' : 'Discord reminders are off.'; }
    catch (e) { control.checked = !enabled; byId('mi-reminder-status').textContent = e.message; }
    finally { control.disabled = false; }
  });
  addMessage('assistant', 'Hi, I’m Vendora Intel. I can help you get set up, troubleshoot your tools or sort out your next step. What do you need help with?');
  if (location.hash === '#intelligence') open();
})();
