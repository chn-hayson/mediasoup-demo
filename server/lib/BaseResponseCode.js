class BaseResponseCode {
    /**
     * code
     */
    code;

    /**
     * 说明
     */
    status;

    constructor(code, status) {
        this.code = code;
        this.status = status;
    }

    /************************************/

    static SUCCESS = new BaseResponseCode(200, 'success');
    static FAILED = new BaseResponseCode(500, 'failed');
}

module.exports =BaseResponseCode