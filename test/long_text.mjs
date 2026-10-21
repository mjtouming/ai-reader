// 约 2.6 万字的合成中文长文。句子短而均匀，方便分段贴着阶梯走；
// 开头是单独的标题；后部有一句没有逗号的长句，用来确认不会从汉字中间切开。

const SENTENCES = [
  "天色渐渐暗了下来，街上的灯一盏盏亮起。",
  "他说完这番话便推门走了出去。",
  "屋里的人谁也没有再开口。",
  "风从窗缝里钻进来，吹得灯火轻轻摇晃。",
  "她把信纸折好，收进了抽屉最深处。",
  "远处传来一阵忽远忽近的锣鼓声。",
  "孩子趴在窗边，眼睛一眨也不眨。",
  "老先生咳了两声，重新捧起了书。"
];

export const MONSTER = "甲".repeat(500) + "。";

export function buildLongText() {
  const paragraphs = ["序"];
  let chars = 0;
  let buf = [];
  let monsterPlaced = false;
  let n = 0;
  while (chars < 26000) {
    if (!monsterPlaced && chars >= 20000) {
      if (buf.length) {
        paragraphs.push(buf.join(""));
        buf = [];
      }
      paragraphs.push(MONSTER);
      chars += MONSTER.length;
      monsterPlaced = true;
      continue;
    }
    // 每句带序号，避免整段文字循环后撞上音频缓存，把「每段只请求一次」测假。
    const s = `第${n + 1}句：` + SENTENCES[n % SENTENCES.length];
    n++;
    buf.push(s);
    chars += s.length;
    // 一段超过 300 字，旧算法才会把单独的标题「序」留成极短的第 1 段。
    if (buf.length === 24) {
      paragraphs.push(buf.join(""));
      buf = [];
    }
  }
  if (buf.length) paragraphs.push(buf.join(""));
  return paragraphs.join("\n\n");
}

export const BOOK_B_TEXT = [
  "城南旧事别册从此处另起一本，用来确认换书之后不会把上一本的声音播出来。",
  "码头的风比城里硬，咸味一直沾在袖口上。",
  "船夫把缆绳绕了三圈，才回头看了她一眼。",
  "这段文字只属于第二本书，不该出现在第一本的播放器里。"
].join("");
