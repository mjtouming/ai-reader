const videoId = "H14bBuluwB8";

async function run() {

  const html = await fetch(
    `https://www.youtube.com/watch?v=${videoId}`,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
      }
    }
  ).then(r => r.text());

  const start = html.indexOf("ytInitialPlayerResponse =");
  const end = html.indexOf(";</script>", start);

  if (start === -1) {
    console.log("没有找到 ytInitialPlayerResponse");
    return;
  }

  const jsonStr = html
    .slice(start + 26, end)
    .trim();

  const data = JSON.parse(jsonStr);

  const tracks =
    data.captions.playerCaptionsTracklistRenderer.captionTracks;

  const track = tracks.find(t => t.languageCode === "en");

  const xml = await fetch(track.baseUrl).then(r => r.text());

  const texts = [...xml.matchAll(/<text[^>]*>(.*?)<\/text>/g)]
    .map(x => x[1])
    .join(" ");

  console.log(texts.slice(0,500));
}

run();