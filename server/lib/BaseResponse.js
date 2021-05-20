const BaseResponseCode = require('./BaseResponseCode');

class BaseResponse {

    /**
     * 返回code
     */
    code;

    /**
     * 返回时间
     */
    status;

    /**
     * 返回消息
     */
    message;

    /**
     * 返回数据
     */
    data;

    /**
     * 
     * @param code {number} 返回code
     * @param msg {string} 返回消息
     * @param data {any} 返回具体对象
     */
    constructor(code, status, message, data) {
        this.code = code;
        this.status = status;
        this.message = message;
        this.data = data;
    }

    /**
     * 成功
     * @param data {any} 返回对象
     * @return {BaseResponse}
     */
    static success(data) {
        return new BaseResponse(BaseResponseCode.SUCCESS.code, BaseResponseCode.SUCCESS.status, null, data);
    }

    /**
     * 失败
     */
    static failed(status, errMessage) {
        return new BaseResponse(BaseResponseCode.FAILED.code, status ? status : BaseResponseCode.FAILED.status, errMessage, null);
    }
}

module.exports = BaseResponse