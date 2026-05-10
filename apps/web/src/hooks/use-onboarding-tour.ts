import { type DriveStep, driver } from "driver.js";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import "driver.js/dist/driver.css";

const TOUR_SHOWN_KEY = "nexu_onboarding_tour_shown";

export function useOnboardingTour({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const started = useRef(false);

  useEffect(() => {
    if (!enabled || started.current) return;
    if (localStorage.getItem(TOUR_SHOWN_KEY) === "1") return;

    const el = document.getElementById("guide-channel-cards");
    if (!el) return;

    started.current = true;

    const steps: DriveStep[] = [
      {
        element: "#guide-channel-cards",
        popover: {
          title: t("tour.step1.title"),
          description: t("tour.step1.desc"),
          side: "top",
          align: "center",
        },
      },
      {
        element: "#nav-recharge",
        popover: {
          title: t("tour.step2.title"),
          description: t("tour.step2.desc"),
          side: "right",
          align: "center",
        },
      },
      {
        element: "#nav-runtime",
        popover: {
          title: t("tour.step3.title"),
          description: t("tour.step3.desc"),
          side: "right",
          align: "center",
        },
      },
    ];

    const driverObj = driver({
      showProgress: true,
      animate: true,
      overlayColor: "rgba(0, 0, 0, 0.65)",
      stagePadding: 8,
      stageRadius: 12,
      popoverClass: "nexu-tour-popover",
      nextBtnText: t("tour.next"),
      prevBtnText: t("tour.prev"),
      doneBtnText: t("tour.done"),
      steps,
      onDestroyed: () => {
        localStorage.setItem(TOUR_SHOWN_KEY, "1");
      },
    });

    const timer = setTimeout(() => driverObj.drive(), 600);
    return () => clearTimeout(timer);
  }, [enabled, t]);
}
