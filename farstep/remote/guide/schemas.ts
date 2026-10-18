import { objectSchema } from "@ai/core/schema/input";
import { Struct } from "effect";
import * as v from "valibot";
import { TOPICS } from "./topics";

export function createGuideParameters() {
  // TOPICS is the complete static set of accepted guide topic names
  const topics = Struct.keys(TOPICS);
  const inputFields = v.object({
    topic: v.pipe(
      v.optional(v.picklist(topics)),
      v.description("Load the topic needed for the next action"),
    ),
  });
  const guideParameters = objectSchema(inputFields);
  return { guideParameters };
}
