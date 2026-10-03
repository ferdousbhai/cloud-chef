const apiStatus = document.querySelector("#api-status");

async function checkApi() {
  try {
    const response = await fetch("/api/health");
    return response.ok ? "Healthy" : `HTTP ${response.status}`;
  } catch {
    return "Unreachable";
  }
}

void checkApi().then((text) => {
  if (apiStatus) {
    apiStatus.textContent = text;
  }
});
