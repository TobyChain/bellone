import type { ThemeKey } from "./store.js";
import { store } from "./store.js";

export const THEME_META: Record<ThemeKey, { label: string; action: string }> = {
  water: { label: "喝水", action: "起身接一杯 200–300ml 温水，慢慢喝完~" },
  stand: { label: "起身", action: "站起来走两步，倒杯水或去趟窗边，给腰背放个假。" },
  eyes: { label: "远眺", action: "看向 6 米外 20 秒，眨眨眼，给眼睛做个 SPA。" },
  stretch: { label: "拉伸", action: "肩颈画圈 5 次，双手向上伸展 10 秒。" },
};

const TIPS: Record<ThemeKey, string[]> = {
  water: [
    "代码 bug 可以慢慢调，但缺水的脑细胞可不会自己 debug 哦。",
    "大脑 75% 是水，掉线卡顿时先怀疑水位不足。",
    "小口多次比一次牛饮更护肾，温水优先。",
    "尿液淡黄是水分刚好的信号灯。",
    "咖啡续命也要用水续杯，1:1 补回来。",
    "饭前一杯水，既解渴又防止午饭点太多。",
  ],
  stand: [
    "久坐 1 小时 ≈ 血液循环打了瞌睡，起身 2 分钟就能叫醒它。",
    "站起来的这一刻，你的腰椎间盘正在给你点赞。",
    "走到窗边看看天，顺便让灵感透透气。",
    "接水、倒水、上洗手间——完美的起身三连。",
    "站立时顺便垫垫脚尖 10 次，小腿泵血泵起来。",
    "会议也可以站着开，思路说不定更快。",
  ],
  eyes: [
    "20-20-20 法则：每 20 分钟，看 20 英尺外，20 秒。",
    "屏幕不会眨眼，但你要多眨——干眼星人自救指南第一条。",
    "远处的绿色是眼睛最爱的护肤品。",
    "闭眼 10 秒 + 转眼球一圈，比眼药水还提神。",
    "把屏幕亮度调到和环境差不多，眼睛压力减半。",
    "看窗外发呆不是摸鱼，是眼部维保工程。",
  ],
  stretch: [
    "肩颈是程序员的第二块显卡，别让它过热降频。",
    "双手抱头往后仰 10 秒，胸椎会谢谢你。",
    "手腕画 8 字，键盘手远离腱鞘炎。",
    "扭扭脖子听见轻响没关系，疼就要休息了。",
    "深呼吸 3 次配合伸展，压力值 -20%。",
  ],
};

const RECENT_WINDOW = 4;

export function pickTip(theme: ThemeKey): string {
  const pool = TIPS[theme];
  const recent = store.state.recentTips[theme] ?? [];
  const candidates = pool.map((_, i) => i).filter((i) => !recent.includes(i));
  const pickFrom = candidates.length > 0 ? candidates : pool.map((_, i) => i);
  const idx = pickFrom[Math.floor(Math.random() * pickFrom.length)];
  store.state.recentTips[theme] = [...recent, idx].slice(-Math.min(RECENT_WINDOW, pool.length - 1));
  return pool[idx];
}
