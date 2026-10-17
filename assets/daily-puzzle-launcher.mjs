const launch = document.querySelector("[data-daily-puzzle-launch]");
if (launch) {
  const status = document.getElementById("dailyPuzzleStorageStatus");
  let loadPromise = null;
  let experience = null;

  launch.disabled = false;
  launch.removeAttribute("aria-disabled");
  launch.addEventListener("click", async () => {
    if (experience) {
      experience.openDailyMode();
      return;
    }

    launch.disabled = true;
    if (status) status.textContent = "Loading and checking today's original puzzle…";
    loadPromise ||= import("./daily-puzzle.mjs?v=daily-compact-v1")
      .then((module) => module.bootDailyPuzzle());
    try {
      experience = await loadPromise;
      experience.openDailyMode();
    } catch (error) {
      loadPromise = null;
      if (status) status.textContent = `Today's puzzle could not be loaded or validated. ${error instanceof Error ? error.message : "Reconnect and try again."}`;
    } finally {
      launch.disabled = false;
    }
  });
}
