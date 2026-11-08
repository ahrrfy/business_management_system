import { describe, expect, it } from "vitest";
import {
  buildGoogleMapsUrl,
  extractShortMapUrl,
  isAllowedGoogleMapsResolveUrl,
  normalizeCoordinateText,
  parseGeoCoordinates,
} from "./geoCoordinates";

describe("shared/geoCoordinates", () => {
  it("normalizes Eastern Arabic and Persian digits plus Arabic commas", () => {
    expect(normalizeCoordinateText("٣٣.٣١٥٢٤١، ٤٤.٣٦٦٠٦٧")).toBe("33.315241, 44.366067");
    expect(parseGeoCoordinates("٣٣.٣١٥٢٤١، ٤٤.٣٦٦٠٦٧")).toEqual({
      lat: 33.315241,
      lng: 44.366067,
    });
  });

  it("prioritizes exact !3d!4d pin coordinates over @viewport camera coordinates", () => {
    const url =
      "https://www.google.com/maps/place/Baghdad/@33.310000,44.350000,14z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d33.315241!4d44.366067";
    expect(parseGeoCoordinates(url)).toEqual({
      lat: 33.315241,
      lng: 44.366067,
    });
  });

  it("parses query, ll, destination, /maps/search/, and geo: URIs including multi-line WhatsApp text", () => {
    const whatsappMsg = [
      "السلام عليكم، هذا موقع البيت للتوصيل:",
      "https://www.google.com/maps/search/?api=1&query=33.298765,44.412345",
      "قرب جامع النداء",
    ].join("\n");
    expect(parseGeoCoordinates(whatsappMsg)).toEqual({
      lat: 33.298765,
      lng: 44.412345,
    });
    expect(parseGeoCoordinates("geo:33.312805,44.361488?z=16")).toEqual({
      lat: 33.312805,
      lng: 44.361488,
    });
    expect(
      parseGeoCoordinates("https://maps.google.com/maps?daddr=33.340111,44.390222"),
    ).toEqual({
      lat: 33.340111,
      lng: 44.390222,
    });
  });

  it("rejects out-of-range coordinates, (0, 0), and plain Iraqi street/phone numbers", () => {
    expect(parseGeoCoordinates("0, 0")).toBeNull();
    expect(parseGeoCoordinates("95.1234, 44.3661")).toBeNull();
    expect(parseGeoCoordinates("33.3152, 190.0001")).toBeNull();
    expect(parseGeoCoordinates("بغداد المنصور محلة 609 زقاق 14 دار 8")).toBeNull();
    expect(parseGeoCoordinates("07701234567")).toBeNull();
  });

  it("detects SSRF-safe Google Maps short URLs and builds Universal Cross-Platform URLs", () => {
    expect(
      extractShortMapUrl("تفضل الموقع: https://maps.app.goo.gl/AbCdEf123456!"),
    ).toBe("https://maps.app.goo.gl/AbCdEf123456");
    expect(isAllowedGoogleMapsResolveUrl("https://maps.app.goo.gl/AbCdEf123456")).toBe(true);
    expect(isAllowedGoogleMapsResolveUrl("http://maps.app.goo.gl/AbCdEf123456")).toBe(false);
    expect(isAllowedGoogleMapsResolveUrl("https://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isAllowedGoogleMapsResolveUrl("https://evil.example.com/maps")).toBe(false);
    expect(buildGoogleMapsUrl("33.315241", "44.366067")).toBe(
      "https://www.google.com/maps/search/?api=1&query=33.315241,44.366067",
    );
    expect(buildGoogleMapsUrl(0, 0)).toBeNull();
  });
});
