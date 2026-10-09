import { PlantReferenceClient } from "@/components/PlantReferenceClient";

// The catalog is the whole app, so it lives at the root rather than behind a
// /plant-reference path it no longer shares with anything.
export default function PlantsPage() {
  return <PlantReferenceClient />;
}
