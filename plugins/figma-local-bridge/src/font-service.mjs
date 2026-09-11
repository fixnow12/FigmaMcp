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
          error.blockers = [{ type: "font", family: font.family, style: font.style, stage }];
          error.nextStep = "Проверьте доступность указанного семейства и начертания в целевом файле. Если вкладка действительно фоновая, активируйте её; isActive в статусе отражает последнее событие, а не активную вкладку и не причину тайм-аута. Не просите повторно открыть уже активный файл. После восстановления повторите только render_screen с dryRun:true. Не подменяйте шрифт. Повтор записи допустим только после проверки её результата.";
          reject(error);
        }, 8000);
      })]);
      return result;
    } finally { clearTimeout(timer); }
  }
  return { wait };
}
