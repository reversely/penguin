// An agent identity's avatar (identity plan section 3): a crop of Penguin's logo around the head, in
// the two colours the logo has, the owner's person hue and white. A feature's builder shows the logo
// in the hue on white; the owner's steward shows the same crop inverted, white on the hue. Nothing is
// stored per identity, so a new or duplicated identity gets its avatar on first render and keeps it
// on every page and device. Pure, so the rule is tested without a browser (test/penguin-face.test.ts).
//
// Colour comes from classes, because the Content Security Policy allows no inline style: the
// `.person-<hue>` class on the SVG sets --person, which `.fill-person` paints.

import { STEWARD_NAME } from "@penguin/protocol";

import { personHue, type PersonHue } from "./person-hue.ts";

/**
 * Penguin's logo (penguin_logo.svg, viewBox 0 0 1024 1222) as one path of three subpaths: the
 * outline, the belly and the eye. Drawn with the even-odd rule, the belly and the eye are holes that
 * show what lies beneath.
 */
export const LOGO_PATH =
  "M 636.0 101.0 Q 609.0 88.0 591.0 83.5 Q 573.0 79.0 541.5 77.5 Q 510.0 76.0 487.0 78.0 Q 464.0 80.0 443.5 86.0 Q 423.0 92.0 405.0 101.0 Q 387.0 110.0 372.5 120.5 Q 358.0 131.0 339.5 151.0 Q 321.0 171.0 306.5 196.5 Q 292.0 222.0 264.5 224.0 Q 237.0 226.0 214.0 230.5 Q 191.0 235.0 176.5 241.0 Q 162.0 247.0 152.5 256.5 Q 143.0 266.0 141.5 270.5 Q 140.0 275.0 140.5 279.5 Q 141.0 284.0 147.5 291.5 Q 154.0 299.0 158.0 301.0 Q 162.0 303.0 229.5 318.5 Q 297.0 334.0 301.0 337.0 Q 305.0 340.0 305.5 356.5 Q 306.0 373.0 302.0 390.0 Q 298.0 407.0 292.0 420.5 Q 286.0 434.0 264.5 469.0 Q 243.0 504.0 229.0 532.0 Q 215.0 560.0 205.5 588.5 Q 196.0 617.0 190.5 650.0 Q 185.0 683.0 184.5 714.5 Q 184.0 746.0 186.0 768.5 Q 188.0 791.0 191.5 809.0 Q 195.0 827.0 201.0 846.5 Q 207.0 866.0 213.0 881.0 Q 219.0 896.0 231.0 918.0 Q 243.0 940.0 253.5 955.5 Q 264.0 971.0 287.0 998.0 Q 310.0 1025.0 308.5 1027.5 Q 307.0 1030.0 293.0 1033.0 Q 279.0 1036.0 268.5 1041.0 Q 258.0 1046.0 250.5 1052.5 Q 243.0 1059.0 240.5 1064.5 Q 238.0 1070.0 237.5 1076.5 Q 237.0 1083.0 241.0 1090.0 Q 245.0 1097.0 251.5 1102.0 Q 258.0 1107.0 273.0 1110.0 Q 288.0 1113.0 313.5 1114.5 Q 339.0 1116.0 502.5 1116.0 Q 666.0 1116.0 675.0 1114.5 Q 684.0 1113.0 691.5 1109.5 Q 699.0 1106.0 708.0 1098.0 Q 717.0 1090.0 724.0 1078.5 Q 731.0 1067.0 736.5 1046.0 Q 742.0 1025.0 742.5 1010.0 Q 743.0 995.0 740.5 974.0 Q 738.0 953.0 732.0 932.0 Q 726.0 911.0 712.5 882.5 Q 699.0 854.0 672.5 812.5 Q 646.0 771.0 637.0 754.5 Q 628.0 738.0 625.5 727.0 Q 623.0 716.0 624.0 713.5 Q 625.0 711.0 628.5 708.5 Q 632.0 706.0 638.0 708.5 Q 644.0 711.0 649.5 715.5 Q 655.0 720.0 672.5 738.5 Q 690.0 757.0 706.0 779.5 Q 722.0 802.0 738.5 833.5 Q 755.0 865.0 762.5 886.0 Q 770.0 907.0 774.5 926.0 Q 779.0 945.0 781.0 988.5 Q 783.0 1032.0 784.5 1037.0 Q 786.0 1042.0 790.5 1039.5 Q 795.0 1037.0 801.0 1030.5 Q 807.0 1024.0 817.5 1009.0 Q 828.0 994.0 837.5 976.5 Q 847.0 959.0 854.5 941.0 Q 862.0 923.0 871.0 893.0 Q 880.0 863.0 884.5 834.5 Q 889.0 806.0 890.0 772.5 Q 891.0 739.0 888.5 705.0 Q 886.0 671.0 879.5 639.5 Q 873.0 608.0 861.0 573.5 Q 849.0 539.0 838.5 517.0 Q 828.0 495.0 806.5 460.5 Q 785.0 426.0 784.0 378.5 Q 783.0 331.0 780.0 303.0 Q 777.0 275.0 771.0 257.0 Q 765.0 239.0 753.0 215.5 Q 741.0 192.0 726.5 173.5 Q 712.0 155.0 697.5 141.5 Q 683.0 128.0 673.0 121.0 Q 663.0 114.0 636.0 101.0 Z M 343.0 336.0 Q 345.0 333.0 370.0 333.0 Q 395.0 333.0 412.0 338.0 Q 429.0 343.0 440.5 348.5 Q 452.0 354.0 468.0 365.5 Q 484.0 377.0 493.5 387.0 Q 503.0 397.0 510.5 408.0 Q 518.0 419.0 521.0 426.0 Q 524.0 433.0 527.0 446.0 Q 530.0 459.0 529.5 469.0 Q 529.0 479.0 513.0 528.5 Q 497.0 578.0 492.5 603.5 Q 488.0 629.0 487.0 658.0 Q 486.0 687.0 489.0 721.5 Q 492.0 756.0 502.5 793.0 Q 513.0 830.0 523.5 852.5 Q 534.0 875.0 554.5 906.5 Q 575.0 938.0 598.0 964.5 Q 621.0 991.0 626.5 1000.0 Q 632.0 1009.0 632.0 1016.5 Q 632.0 1024.0 625.5 1031.5 Q 619.0 1039.0 600.0 1041.0 Q 581.0 1043.0 541.5 1042.5 Q 502.0 1042.0 479.5 1036.0 Q 457.0 1030.0 436.0 1021.0 Q 415.0 1012.0 391.0 997.0 Q 367.0 982.0 338.0 954.5 Q 309.0 927.0 291.5 901.5 Q 274.0 876.0 263.5 853.5 Q 253.0 831.0 245.5 798.5 Q 238.0 766.0 236.5 743.5 Q 235.0 721.0 236.5 698.0 Q 238.0 675.0 241.0 657.0 Q 244.0 639.0 250.0 618.0 Q 256.0 597.0 263.5 579.0 Q 271.0 561.0 280.0 543.0 Q 289.0 525.0 308.0 494.0 Q 327.0 463.0 335.5 444.0 Q 344.0 425.0 346.5 414.5 Q 349.0 404.0 349.5 392.0 Q 350.0 380.0 349.0 368.0 Q 348.0 356.0 344.5 347.5 Q 341.0 339.0 343.0 336.0 Z M 448.5 206.0 Q 454.0 203.0 458.5 202.5 Q 463.0 202.0 471.0 204.5 Q 479.0 207.0 485.0 212.0 Q 491.0 217.0 494.0 223.0 Q 497.0 229.0 497.0 236.5 Q 497.0 244.0 494.5 249.5 Q 492.0 255.0 485.0 261.5 Q 478.0 268.0 473.5 269.5 Q 469.0 271.0 463.0 271.0 Q 457.0 271.0 450.0 268.0 Q 443.0 265.0 439.5 261.5 Q 436.0 258.0 432.5 251.0 Q 429.0 244.0 428.5 238.0 Q 428.0 232.0 430.5 225.5 Q 433.0 219.0 438.0 214.0 Q 443.0 209.0 448.5 206.0 Z";

export const LOGO_VIEWBOX = "0 0 1024 1222";

/** The head crop: the square in logo coordinates round the circle centred on (500, 400) with radius 390. */
export const FACE_VIEWBOX = "110 10 780 780";

export type FaceFill = "fill-person" | "fill-white";

export interface FaceColours {
  readonly hue: PersonHue;
  /** The disc behind the logo, which also shows through the belly and the eye. */
  readonly ground: FaceFill;
  readonly figure: FaceFill;
}

/** The person a handle's "@owner/" half names, or "" for a handle without one. */
export function handleOwner(handle: string): string {
  const slash = handle.indexOf("/");
  return slash === -1 ? "" : handle.slice(1, slash);
}

/**
 * The avatar of the identity with this handle, in the hue of `owner`, by default the handle's owner
 * half. A steward has the handle `@<person>/steward` (stewardHandle in @penguin/protocol), which a
 * builder's handle never takes.
 */
export function penguinFace(handle: string, assigned: ReadonlyMap<string, PersonHue>, owner = handleOwner(handle)): FaceColours {
  const steward = handle.endsWith(`/${STEWARD_NAME}`);
  return {
    hue: personHue(owner, assigned),
    ground: steward ? "fill-person" : "fill-white",
    figure: steward ? "fill-white" : "fill-person",
  };
}
