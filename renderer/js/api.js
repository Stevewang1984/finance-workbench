'use strict';
/* 主进程调用封装：统一处理错误 */
window.FW = {
  async call(op, payload) {
    const r = await window.api.call(op, payload);
    if (r && r.__error) throw new Error(r.message || '调用失败');
    return r;
  }
};
