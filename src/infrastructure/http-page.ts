export const httpPage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PixelFlow</title>
  <script src="/app.js" defer></script>
</head>
<body>
  <main>
    <h1>PixelFlow</h1>
    <p>Upload an image, track its job and download the generated variants.</p>
    <p><label>Access token <input id="token" type="password" autocomplete="off"></label>
      <button id="connect" type="button">Load pipelines</button></p>
    <form id="upload">
      <p><label>Pipeline <select id="pipeline" required></select></label></p>
      <p><label>Image (JPEG, PNG or WebP, up to 20 MiB)
        <input id="image" type="file" accept="image/jpeg,image/png,image/webp" required></label></p>
      <button id="send" type="submit" disabled>Upload image</button>
    </form>
    <h2>Job status</h2>
    <form id="track">
      <label>Job ID <input id="job" required pattern="[a-f0-9\\-]{36}"></label>
      <button type="submit">Track job</button>
    </form>
    <p id="status" role="status"></p>
    <ul id="files"></ul>
  </main>
</body>
</html>`;

export const httpScript = `
const $ = (id) => document.getElementById(id);
let timer;
let tracking = 0;
const status = (text) => { $("status").textContent = text; };

async function request(path, options = {}) {
  const token = $("token").value.trim();
  if (!token) throw new Error("Enter an access token.");
  const response = await fetch(path, {
    ...options,
    headers: { ...options.headers, Authorization: "Bearer " + token },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? ("HTTP " + response.status));
  }
  return response;
}

$("connect").addEventListener("click", async () => {
  try {
    const { pipelines } = await (await request("/api/v1/pipelines")).json();
    $("pipeline").replaceChildren(...pipelines.map((id) => new Option(id, id)));
    $("send").disabled = pipelines.length === 0;
    status("Choose a pipeline and an image.");
  } catch (error) {
    status(error.message);
  }
});

function track(id) {
  clearTimeout(timer);
  const current = ++tracking;
  $("files").replaceChildren();
  $("job").value = id;
  status("Loading job ...");
  async function refresh() {
    try {
      const job = await (await request("/api/v1/jobs/" + encodeURIComponent(id))).json();
      if (current !== tracking) return;
      status(job.id + ": " + job.status + " (" + job.attempts + " attempts)");
      if (["completed", "failed", "cancelled"].includes(job.status)) {
        for (const file of job.files) {
          const item = document.createElement("li");
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = "Download " + file.name;
          button.addEventListener("click", async () => {
            try {
              const blob = await (await request(file.url)).blob();
              const link = document.createElement("a");
              link.href = URL.createObjectURL(blob);
              link.download = file.name;
              link.click();
              setTimeout(() => URL.revokeObjectURL(link.href), 5000);
            } catch (error) {
              status(error.message);
            }
          });
          item.append(button);
          $("files").append(item);
        }
      } else {
        timer = setTimeout(refresh, 2000);
      }
    } catch (error) {
      if (current === tracking) status(error.message);
    }
  }
  void refresh();
}

$("upload").addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = $("image").files[0];
  if (!file) return;
  $("send").disabled = true;
  status("Uploading image ...");
  try {
    const path = "/api/v1/pipelines/" + encodeURIComponent($("pipeline").value) + "/jobs";
    const { id } = await (await request(path, {
      method: "POST",
      headers: { "Content-Type": file.type },
      body: file,
    })).json();
    track(id);
  } catch (error) {
    status(error.message);
  } finally {
    $("send").disabled = false;
  }
});

$("track").addEventListener("submit", (event) => {
  event.preventDefault();
  track($("job").value.trim());
});
`;
