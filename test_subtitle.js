const videoId = "H14bBuluwB8";

async function run() {

  const res = await fetch(
    `https://www.youtube.com/watch?v=${videoId}&hl=en`,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9"
      }
    }
  );

  const html = await res.text();

  const start = html.indexOf("ytInitialPlayerResponse =");
  const end = html.indexOf(";</script>", start);

  if (start === -1) {
    console.log("没有找到 ytInitialPlayerResponse");
    return;
  }

  const jsonStr = html.slice(start + 26, end);
  const data = JSON.parse(jsonStr);

  if (!data.captions) {
    console.log("这个视频没有字幕");
    return;
  }

  const tracks =
    data.captions.playerCaptionsTracklistRenderer.captionTracks;

  const track = tracks.find(t => t.languageCode === "en") || tracks[0];

  const xml = await fetch(track.baseUrl).then(r => r.text());

  const texts = [...xml.matchAll(/<text[^>]*>(.*?)<\/text>/g)]
    .map(x => x[1])
    .join(" ");

  console.log(texts.slice(0,500));
}

run();