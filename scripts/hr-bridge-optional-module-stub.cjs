"use strict";

// The bridge does not use optional native accelerators or terminal colouring.
// Throwing during require preserves the dependencies' documented optional
// fallback paths while preventing a release from resolving mutable ancestors.
throw new Error("HR_BRIDGE_OPTIONAL_MODULE_DISABLED");
