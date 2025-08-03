"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RateLimiterError = void 0;
var RateLimiterError = (function () {
    function RateLimiterError() {
    }
    RateLimiterError.getAttributeTypeMap = function () {
        return RateLimiterError.attributeTypeMap;
    };
    RateLimiterError.discriminator = undefined;
    RateLimiterError.attributeTypeMap = [
        {
            "name": "errors",
            "baseName": "errors",
            "type": "Array<GenericErrorErrorsInner>",
            "format": ""
        }
    ];
    return RateLimiterError;
}());
exports.RateLimiterError = RateLimiterError;
//# sourceMappingURL=RateLimiterError.js.map