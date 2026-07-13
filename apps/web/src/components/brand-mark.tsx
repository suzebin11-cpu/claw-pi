interface BrandMarkProps {
  className?: string;
}

export function BrandMark({ className }: BrandMarkProps) {
  return (
    <div
      className={`rounded-lg overflow-hidden bg-black ${className ?? ""}`}
      aria-hidden="true"
    >
      <img
        src="/claw-pi-avatar.png"
        alt=""
        className="w-full h-full object-cover"
      />
    </div>
  );
}
