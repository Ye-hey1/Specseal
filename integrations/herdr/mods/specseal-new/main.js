// 这个文件夹只让 mod.open:specseal-new 开得到技能跳窗，画面在 specseal mod 的 skill-picker.js。
// 一个 mod 只能设置一种 overlay，Herdr 也不让 mod 引用别的文件夹的程序，所以用 mod.json 指过去。
import { View, div } from "gpui-kit";

export default class SpecsealNew extends View {
  render() {
    return div();
  }
}
