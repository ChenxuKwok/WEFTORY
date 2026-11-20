(() => {
  if (!window.electron?.fashion) return;

  let language = navigator.language === 'zh-CN' ? 'zh' : 'en';
  try {
    const saved = localStorage.getItem('lobster-language');
    if (saved === 'zh' || saved === 'en') language = saved;
  } catch {
    // Use the system language when storage is unavailable.
  }

  document.documentElement.classList.add('fashion-studio');
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  document.title = 'WEFTORY';
  const mark = document.querySelector('.splash-logo');
  mark.src = 'weftory-mark.png';
  mark.alt = '';
  document.getElementById('splash-title').textContent = 'WEFTORY';
  document.getElementById('splash-subtitle').textContent =
    language === 'zh' ? '正在加载工作室…' : 'Loading studio…';
})();
