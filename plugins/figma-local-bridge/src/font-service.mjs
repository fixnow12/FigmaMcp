// Serialized into generated Plugin API code; keep this factory self-contained.
export function createFontService() {
  async function wait(promise, font, stage) {
    // Font loading/listing only affects Figma's font cache. Abandoning this await
    // cannot mutate a node later; never apply this race to a canvas write.
    let timer;
    try {
      const result = await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("Служба шрифтов Figma не ответила за 8 секунд: " + stage + " «" + font.family + " / " + font.style + "». Отсутствие шрифта не подтверждено.");
          error.code = "FONT_SERVICE_TIMEOUT";
          error.operationStatus = "not_applied";
          error.retryPolicy = "after_state_change";
          error.blockers = [{ type: "font", family: font.family, style: font.style, stage }];
          error.nextStep = "Не повторяйте неизменённый запрос после sleep: состояние Figma не изменилось. Проверьте доступность указанного семейства и начертания в целевом файле. Если вкладка действительно фоновая, активируйте её; иначе вручную примените именно этот шрифт к временному тексту и подтвердите восстановление. Только после фактического изменения состояния повторите один раз render_screen с dryRun:true. isActive не доказывает причину тайм-аута. Не подменяйте шрифт.";
          reject(error);
        }, 8000);
      })]);
      return result;
    } finally { clearTimeout(timer); }
  }
  return { wait };
}
